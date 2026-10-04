"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";

export function TopBar({
  title,
  back,
  right,
  subtitle,
}: {
  title: React.ReactNode;
  back?: string;
  right?: React.ReactNode;
  subtitle?: React.ReactNode;
}) {
  return (
    <header
      className="sticky top-0 z-20 border-b border-line bg-bg/95 backdrop-blur"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="mx-auto flex min-h-14 max-w-xl items-center gap-1 px-2">
        {back ? (
          <Link href={back} className="btn-icon" aria-label="Back">
            <ChevronLeft size={24} aria-hidden />
          </Link>
        ) : (
          <span className="w-2" />
        )}
        <div className="min-w-0 flex-1 py-2">
          <h1 className="truncate text-lg font-bold leading-tight">{title}</h1>
          {subtitle && <p className="truncate text-sm text-muted">{subtitle}</p>}
        </div>
        {right}
      </div>
    </header>
  );
}
