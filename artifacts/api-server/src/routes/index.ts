import { Router, type IRouter } from "express";
import healthRouter from "./health";
import livekitRouter from "./livekit";
import aiRouter from "./ai";
import meetingsRouter from "./meetings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(livekitRouter);
router.use(aiRouter);
router.use(meetingsRouter);

export default router;
