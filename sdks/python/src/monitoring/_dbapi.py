"""Trace DB-API connection shortcut methods.

sqlite3 (and psycopg 3) connections have ``execute``/``executemany``/``executescript`` shortcuts that create a cursor
internally. OpenTelemetry's DB-API proxy only traces queries run through ``connection.cursor()``, so queries issued
with the shortcuts produced no spans. Monitoring routes the shortcuts through a traced cursor, with the same return
value (the cursor) as the native method.
"""


def _shortcut(name):
    def method(self, *args, **kwargs):
        if not hasattr(self.__wrapped__, name):
            raise AttributeError(name)
        return getattr(self.cursor(), name)(*args, **kwargs)
    method.__name__ = name
    return method


def patch_connection_shortcuts():
    try:
        from opentelemetry.instrumentation import dbapi
    except ImportError:
        return
    proxy = getattr(dbapi, "TracedConnectionProxy", None)
    if proxy is None or getattr(proxy, "_monitoring_shortcuts", False):
        return
    for name in ("execute", "executemany", "executescript"):
        if name not in proxy.__dict__:
            setattr(proxy, name, _shortcut(name))
    proxy._monitoring_shortcuts = True


_SYSTEMS = {"sqlite3": "sqlite", "psycopg": "postgresql", "psycopg2": "postgresql", "pymysql": "mysql", "MySQLdb": "mysql"}


def patch_commit():
    """Trace ``connection.commit()`` as a client span (opt-in: MONITORING_TRACE_DB_COMMIT=true)'s ``<db>.connection.commit`` span."""
    try:
        from opentelemetry import trace
        from opentelemetry.instrumentation import dbapi
    except ImportError:
        return
    proxy = getattr(dbapi, "TracedConnectionProxy", None)
    if proxy is None or getattr(proxy, "_monitoring_commit", False):
        return
    tracer = trace.get_tracer("monitoring.dbapi")

    def commit(self, *args, **kwargs):
        module = type(self.__wrapped__).__module__.split(".")[0]
        system = _SYSTEMS.get(module, module)
        with tracer.start_as_current_span(f"{system}.connection.commit", kind=trace.SpanKind.CLIENT,
                                          attributes={"db.system": system, "db.operation": "COMMIT"}):
            return self.__wrapped__.commit(*args, **kwargs)

    proxy.commit = commit
    proxy._monitoring_commit = True
