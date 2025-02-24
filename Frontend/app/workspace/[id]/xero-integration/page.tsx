import XeroIntegrationPage from './XeroIntegrationPage';
import { workspaces } from '../page';

export function generateStaticParams() {
  return Object.keys(workspaces).map((id) => ({
    id: id,
  }));
}

export default function Page({ params }: { params: { id: string } }) {
  return <XeroIntegrationPage params={params} />;
}