// src/views/settings/CopyButton.tsx — a small Copy button that says "Copied" once done.

import { useState } from "react";
import { Button } from "../../ds";
import { copyText } from "../../lib/format";

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Button
        size="sm"
        onClick={() =>
          void copyText(text).then((err) => {
            setCopied(err === null);
          })
        }
      >
        Copy
      </Button>
      {copied && <span className="small muted3">Copied</span>}
    </>
  );
}
