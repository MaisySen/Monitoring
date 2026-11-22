// Strict experimental envelope admission only. Never decodes or rewrites metric data.
import { StrictDeliveryError } from './strictMetricDelivery';

export function preflightStrictMetricEnvelope(bytes: Uint8Array): void {
  let deprecated = false;
  const invalid = (): never => { throw new StrictDeliveryError(400, 'Invalid metric protobuf envelope'); };
  function scan(start: number, end: number, resource: boolean): void {
    let pos = start;
    // Bounded protobuf varint, including legal 10-byte signed-value encodings.
    const varint = (): bigint => {
      let value = 0n;
      for (let i = 0; i < 10; i++) {
        if (pos >= end) return invalid();
        const b = bytes[pos++];
        if (i === 9 && b > 1) return invalid();
        value |= BigInt(b & 127) << BigInt(i * 7);
        if (!(b & 128)) return value;
      }
      return invalid();
    };
    while (pos < end) {
      const tag = varint();
      if (tag > 0xffffffffn) return invalid();
      const field = Number(tag >> 3n), wire = Number(tag & 7n);
      if (!field || wire === 3 || wire === 4 || wire > 5) return invalid();
      // Validate all envelope bytes first. Malformed data wins over deprecated422,
      // independent of field/container order, even when field1000 has bad wire form.
      if (resource && field === 1000) deprecated = true;
      if ((!resource && field === 1) || (resource && [1, 2, 3].includes(field))) {
        if (wire !== 2) return invalid();
      }
      if (wire === 0) { varint(); continue; }
      if (wire === 1 || wire === 5) {
        pos += wire === 1 ? 8 : 4;
        if (pos > end) return invalid();
        continue;
      }
      const length = varint();
      if (length > BigInt(end - pos)) return invalid();
      const next = pos + Number(length);
      if (!resource && field === 1) scan(pos, next, true);
      // Resource, scope and unknown payloads remain opaque. No nested false matches.
      pos = next;
    }
  }
  scan(0, bytes.length, false);
  if (deprecated) throw new StrictDeliveryError(422, 'Deprecated metric scope containers are unsupported');
}
