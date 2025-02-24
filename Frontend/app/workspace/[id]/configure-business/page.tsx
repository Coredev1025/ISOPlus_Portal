import ConfigureBusinessPage from './ConfigureBusinessPage';
import { workspaces } from '../page';

export function generateStaticParams() {
  return Object.keys(workspaces).map((id) => ({
    id: id,
  }));
}

export default function Page({ params }: { params: { id: string } }) {
  return <ConfigureBusinessPage params={params} />;
}