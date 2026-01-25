import { useMemo } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

function makeData() {
  const now = Date.now();
  let v = 100;
  return Array.from({ length: 60 }).map((_, i) => {
    v += (Math.random() - 0.5) * 2;
    return { t: new Date(now - (59 - i) * 1000).toLocaleTimeString(), v: Number(v.toFixed(2)) };
  });
}

export function LiveChart() {
  const data = useMemo(() => makeData(), []);

  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="font-semibold mb-2">Equity Curve (mock)</div>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <XAxis dataKey="t" hide />
            <YAxis hide domain={["dataMin", "dataMax"]} />
            <Tooltip />
            <Area dataKey="v" type="monotone" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="text-xs text-muted-foreground mt-2">Replace with real equity curve from trades aggregation.</div>
    </div>
  );
}
