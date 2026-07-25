import { parentPort } from "node:worker_threads";
import { installWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { startComputerWorker } from "./tools/computer/worker-entry";

if (!parentPort) throw new Error("computer-worker-process-entry: missing parentPort");

installWorkerInbox(parentPort);
startComputerWorker();
