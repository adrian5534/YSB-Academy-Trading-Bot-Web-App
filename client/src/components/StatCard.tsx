import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function StatCard({
  title,
  value,
  icon,
  trend,
  trendValue,
  valueClass,
}: {
  title: string;
  value: string;
  icon: ReactNode;
  trend: "up" | "down";
  trendValue: string;
  valueClass?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-2xl border border-border bg-card p-4"
    >
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">{title}</div>
        <div className="text-muted-foreground">{icon}</div>
      </div>
      <div className={cn("mt-2 text-2xl font-semibold", valueClass ?? "")}>{value}</div>
      <div className="mt-2 text-xs text-muted-foreground">
        <span className={trend === "up" ? "text-green-500" : "text-red-500"}>{trend === "up" ? "▲" : "▼"}</span>{" "}
        {trendValue}
      </div>
    </motion.div>
  );
}
