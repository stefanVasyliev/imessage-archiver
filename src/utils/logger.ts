import pino, { type LoggerOptions } from "pino";
import { env } from "../config/env.js";

const loggerOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
};

if (process.env.NODE_ENV !== "production") {
  loggerOptions.transport = {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    },
  };
}

export const logger = pino(loggerOptions);
