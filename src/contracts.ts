import { z } from 'zod';

export const analysisInput = z.object({
  transactionId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
  apiId: z.string().min(1).max(200),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
}).strict().superRefine((value, ctx) => {
  const duration = Date.parse(value.to) - Date.parse(value.from);
  if (duration <= 0 || duration > 24 * 60 * 60 * 1000)
    ctx.addIssue({ code: 'custom', message: 'Time range must be positive and at most 24 hours' });
});
export type AnalysisInput = z.infer<typeof analysisInput>;
export const diagnosisSchema = z.object({
  summary: z.string().min(1).max(2000),
  probableCause: z.string().min(1).max(4000),
  confidence: z.enum(['low', 'medium', 'high']),
  evidence: z.array(z.object({
    logId: z.string(),
    specPointer: z.string().nullable(),
    explanation: z.string().min(1).max(2000),
  }).strict()).max(50),
  nextSteps: z.array(z.string().max(1000)).max(20),
  missingInformation: z.array(z.string().max(1000)).max(20),
}).strict();
export type Diagnosis = z.infer<typeof diagnosisSchema>;
export type LogEntry = { id: string; source: 'splunk' | 'api-connect'; data: unknown };

export class ServiceError extends Error {
  constructor(public code: string, message: string, public status = 502) { super(message); }
}
