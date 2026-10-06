import {z} from "zod";

export const diagramRequestSchema = z.object({
  id: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/u),
  isLight: z.boolean(),
  text: z.string().max(20_000),
}).strict();

export const diagramReplySchema = z.discriminatedUnion("type", [
  z.object({type: z.literal("ready")}).strict(),
  z.object({id: z.string(), svg: z.string().max(2_000_000), type: z.literal("result")}).strict(),
  z.object({id: z.string(), type: z.literal("error")}).strict(),
]);
