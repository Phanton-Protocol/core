import React from "react";

export default function Receipt({ receipt }) {
  if (!receipt) return null;
  return (
    <div className="card">
      <div className="label">Receipt</div>
      <pre className="mono">{JSON.stringify(receipt, null, 2)}</pre>
    </div>
  );
}
