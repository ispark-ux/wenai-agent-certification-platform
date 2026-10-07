"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import AdminShell from "@/components/AdminShell";
import ProcessForm from "@/components/ProcessForm";
import { Alert, Spinner } from "@/components/ui";
import { api } from "@/lib/api";

export default function ProcessEditPage() {
  const params = useParams();
  const processId = params?.processId;
  const isNew = processId === "new";
  const [process, setProcess] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(!isNew);

  useEffect(() => {
    if (isNew || !processId) return;
    api
      .getProcess(processId, true)
      .then((d) => setProcess(d.process))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [processId, isNew]);

  return (
    <AdminShell title={isNew ? "Add process" : `Edit process${process ? ` · ${process.process_name}` : ""}`} subtitle="Write the AI customer prompt, evaluator notes and scorecard. The agent never sees the prompt, notes or marks.">
      {error ? (
        <Alert tone="error" title="Error">
          {error}
        </Alert>
      ) : null}
      {loading ? (
        <div className="flex items-center gap-2 text-slate-500">
          <Spinner /> Loading…
        </div>
      ) : isNew || process ? (
        <ProcessForm process={isNew ? null : process} />
      ) : null}
    </AdminShell>
  );
}
