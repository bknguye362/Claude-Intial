
import { Mastra } from '@mastra/core/mastra';
import { PinoLogger } from '@mastra/loggers';
import { LibSQLStore } from '@mastra/libsql';
import { weatherWorkflow } from './workflows/weather-workflow.ts';
import { weatherAgent } from './agents/weather-agent.ts';
import { assistantWorkflow } from './workflows/assistant-workflow.ts';
import { assistantAgent } from './agents/assistant-agent.ts';

export const mastra = new Mastra({
  workflows: { weatherWorkflow, assistantWorkflow },
  agents: { weatherAgent, assistantAgent },
  storage: new LibSQLStore({
    // stores telemetry, evals, ... into memory storage, if it needs to persist, change to file:../mastra.db
    url: ":memory:",
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
