import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The honest stub: a page named in the sidebar whose content belongs to a
 * later wave says so, in the theme, instead of 404ing or pretending.
 */
export function ComingSoon({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="mx-auto max-w-2xl pt-16">
      <Card>
        <CardHeader>
          <CardTitle className="text-lg text-foreground">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted">{blurb}</p>
          <p className="mt-2 text-xs text-muted">Coming in a later wave.</p>
        </CardContent>
      </Card>
    </div>
  );
}
