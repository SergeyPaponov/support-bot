import { z } from 'zod';

const transactionId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
export const transactionAnalysisInput = z.object({ transaction_id: transactionId }).strict();
export type TransactionAnalysisInput = z.infer<typeof transactionAnalysisInput>;

/** UTC elapsed time, independent of local time zones and daylight-saving changes. */
export function transactionSearchWindow(now: Date) {
  const end = now.getTime();
  return { from: new Date(end - 14 * 24 * 60 * 60 * 1000).toISOString(), to: new Date(end).toISOString() };
}

export const analysisInput = z.object({
  transactionId,
  apiId: z.string().min(1).max(200),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
}).strict().superRefine((value, ctx) => {
  const duration = Date.parse(value.to) - Date.parse(value.from);
  if (duration <= 0 || duration > 24 * 60 * 60 * 1000)
    ctx.addIssue({ code: 'custom', message: 'Time range must be positive and at most 24 hours' });
});
export type AnalysisInput = z.infer<typeof analysisInput>;
export type AnalyticsSearchInput = Pick<AnalysisInput, 'transactionId' | 'from' | 'to'>;
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
