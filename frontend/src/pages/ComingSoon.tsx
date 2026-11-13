import { Link } from 'react-router-dom';
import { Badge, Card, PageHeader } from '../components/ui';

/**
 * Honest placeholder for screens whose backend module is not built yet.
 * It states exactly which build step delivers the screen, instead of showing
 * fabricated numbers.
 */
export function ComingSoon({
  title,
  module,
  description,
  bullets,
  backTo,
}: {
  title: string;
  module: string;
  description: string;
  bullets: string[];
  backTo: string;
}) {
  return (
    <div>
      <PageHeader title={title} subtitle={description} actions={<Badge tone="warning">In progress</Badge>} />
      <Card>
        <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">{module}</p>
        <ul className="mt-4 space-y-2 text-sm text-slate-600">
          {bullets.map((bullet) => (
            <li key={bullet} className="flex gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
              {bullet}
            </li>
          ))}
        </ul>
        <Link to={backTo} className="btn-ghost mt-6">
          ← Back to dashboard
        </Link>
      </Card>
    </div>
  );
}
