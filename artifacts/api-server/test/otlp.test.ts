import { test } from "node:test";
import assert from "node:assert/strict";
import protobuf from "protobufjs";
import { encodePartialSuccess, encodeEmptyResponse } from "../src/intake/otlp";

// The OTLP Export*ServiceResponse partial_success envelope, decoded with a real protobuf reader so the
// hand-rolled encoder is verified against the wire format, not against itself.
const root = protobuf.Root.fromJSON({
  nested: {
    pkg: {
      nested: {
        PartialSuccess: { fields: { rejectedDataPoints: { id: 1, type: "int64" }, errorMessage: { id: 2, type: "string" } } },
        Response: { fields: { partialSuccess: { id: 1, type: "PartialSuccess" } } },
      },
    },
  },
});
const Response = root.lookupType("pkg.Response");

test("partial success encodes valid protobuf with rejected count and message", () => {
  const r = encodePartialSuccess("application/x-protobuf", "rejectedDataPoints", 7, "series limit reached");
  assert.equal(r.type, "application/x-protobuf");
  const decoded = Response.decode(r.body as Buffer).toJSON();
  assert.equal(Number(decoded.partialSuccess.rejectedDataPoints), 7);
  assert.equal(decoded.partialSuccess.errorMessage, "series limit reached");
});

test("partial success encodes OTLP/JSON with the signal-specific field name", () => {
  const r = encodePartialSuccess("application/json", "rejectedLogRecords", 3, "daily limit");
  assert.equal(r.type, "application/json");
  assert.deepEqual(JSON.parse(String(r.body)), { partialSuccess: { rejectedLogRecords: 3, errorMessage: "daily limit" } });
});

test("empty responses are unchanged", () => {
  assert.equal(String(encodeEmptyResponse("application/json").body), "{}");
  assert.equal((encodeEmptyResponse("application/x-protobuf").body as Buffer).length, 0);
});
