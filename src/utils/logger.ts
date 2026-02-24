import pino from 'pino';
import { ENV } from '../config/env';

const loggerConfig: any = {
    level: ENV.LOG_LEVEL,
};

if (process.env.NODE_ENV !== 'production') {
    loggerConfig.transport = {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
        },
    };
}

export const logger = pino(loggerConfig);
