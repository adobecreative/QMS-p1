import { z } from "zod";

/** Form helpers: HTML forms send "" for empty fields and "on" for checked boxes. */
export const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

export const requiredText = (max = 200) => z.string().trim().min(1).max(max);

export const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal(""), z.undefined()])
  .transform((v) => v === "on" || v === "true");

/** One value or many (repeated form keys) → array. */
export const stringList = z
  .union([z.string(), z.array(z.string()), z.undefined()])
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).filter(Boolean));

export const commaList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(/[,،\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
