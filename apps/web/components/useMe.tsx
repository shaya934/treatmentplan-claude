"use client";
import { createContext, useContext } from "react";

export interface Me {
  user: { id: string; name: string; email: string; role: string; tenantId: string | null; support: boolean };
  can: Record<string, boolean>;
  mode: "aws" | "local";
  idleMinutes: number;
}

export const MeContext = createContext<Me | null>(null);
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe outside Shell");
  return me;
}
