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
      className={cn("stat-card rounded-2xl border border-border bg-card p-4")}
    >
      <div className="stat-card__top flex items-center justify-between">
        <div className="stat-card__title text-sm text-muted-foreground">{title}</div>
        <div className="stat-card__icon text-muted-foreground">{icon}</div>
      </div>

      <div className={cn("stat-card__value mt-2 text-2xl font-semibold", valueClass ?? "")}>{value}</div>

      <div className="stat-card__meta mt-2 text-xs text-muted-foreground">
        <span className={cn("stat-card__trend", trend === "up" ? "text-green-500" : "text-red-500")}>
          {trend === "up" ? "▲" : "▼"}
        </span>{" "}
        <span className="stat-card__trendValue">{trendValue}</span>
      </div>
    </motion.div>
  );
}
