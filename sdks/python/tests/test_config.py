import unittest
from monitoring.config import configuration, tags


class ConfigTests(unittest.TestCase):
    def test_defaults_and_migration(self):
        c = configuration(environ={"DD_SERVICE": "legacy", "DD_ENV": "qa", "DD_VERSION": "2", "DD_TAGS": "team:core"})
        self.assertEqual(c["endpoints"]["traces"], "http://localhost:4318/v1/traces")
        self.assertEqual(c["attributes"]["service.name"], "legacy")
        self.assertEqual(c["attributes"]["service.version"], "2")
        self.assertEqual(c["attributes"]["deployment.environment"], "qa")
        self.assertEqual(c["attributes"]["team"], "core")
        self.assertEqual(c["attributes"]["telemetry.distro.name"], "monitoring")

    def test_agentless_and_precedence(self):
        c = configuration({"service": "direct"}, {
            "MONITORING_URL": "https://example.test/", "MONITORING_API_KEY": "test-only",
            "MONITORING_SERVICE": "native", "OTEL_SERVICE_NAME": "otel", "DD_SERVICE": "legacy",
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT": "http://ignored",
        })
        self.assertEqual(c["attributes"]["service.name"], "direct")
        self.assertEqual(c["endpoints"]["traces"], "https://example.test/otlp/v1/traces")
        self.assertEqual(c["headers"]["DC-API-KEY"], "test-only")

    def test_otel_and_disabled_injection(self):
        c = configuration(environ={
            "OTEL_EXPORTER_OTLP_ENDPOINT": "http://collector:4318/",
            "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": "http://logs/v1/logs",
            "OTEL_RESOURCE_ATTRIBUTES": "service.name=otel,service.version=3,deployment.environment=dev",
            "MONITORING_LOGS_INJECTION": "false",
        })
        self.assertEqual(c["endpoints"]["metrics"], "http://collector:4318/v1/metrics")
        self.assertEqual(c["endpoints"]["logs"], "http://logs/v1/logs")
        self.assertEqual(c["attributes"]["service.name"], "otel")
        self.assertFalse(c["logs_injection"])

    def test_tags(self):
        self.assertEqual(tags(["a:b:c", "enabled"]), {"a": "b:c", "enabled": True})
        self.assertEqual(tags({"count": 2}), {"count": 2})

    def test_invalid(self):
        with self.assertRaisesRegex(ValueError, "API_KEY"):
            configuration(environ={"MONITORING_URL": "https://example.test"})
        with self.assertRaisesRegex(ValueError, "between"):
            configuration(environ={"MONITORING_SAMPLE_RATE": "2"})

if __name__ == "__main__":
    unittest.main()
