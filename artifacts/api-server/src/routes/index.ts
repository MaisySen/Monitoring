import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import telemetryPg from "./telemetry";
import telemetryCh from "./telemetryCh";
import { useClickHouse } from "../lib/storage";
import resourcesRouter from "./resources";

const router: IRouter = Router();
router.use(healthRouter);
router.use(authRouter);
// Telemetry reads (logs, APM, metrics, hosts) for the storage chosen by MONITORING_STORAGE; both serve the same API.
router.use(useClickHouse ? telemetryCh : telemetryPg);
router.use(resourcesRouter);

export default router;
