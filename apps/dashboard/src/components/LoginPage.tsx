import { Navigate, useLocation } from 'react-router-dom';

/** Old bookmarks use the same email-first entry as every other sign-in. */
export function LoginPage() {
  const { state } = useLocation();
  return <Navigate to="/sign-in" state={state} replace />;
}
