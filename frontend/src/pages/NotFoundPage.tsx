import { Link } from 'react-router-dom';
import { LogoMark } from '../components/ui';

export function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6 text-center">
      <LogoMark className="h-12 w-12" />
      <h1 className="mt-6 text-2xl font-semibold text-slate-900">Page not found</h1>
      <p className="mt-2 max-w-md text-sm text-slate-500">
        That route does not exist. If you followed a link from inside the app, the module may not be enabled yet.
      </p>
      <Link to="/" className="btn-primary mt-6">
        Go to dashboard
      </Link>
    </div>
  );
}
