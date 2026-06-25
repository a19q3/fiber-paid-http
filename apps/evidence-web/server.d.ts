import type { Server } from "node:http";

export type EvidenceWebOptions = {
  apiBase?: string;
};

export declare function startEvidenceWeb(port?: number, options?: EvidenceWebOptions): Server;
