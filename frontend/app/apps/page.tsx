import { AppsManager } from "@/components/AppsManager";
import { PageHeading } from "@/components/PageHeading";

export default function Page() {
  return (
    <>
      <PageHeading title="アプリ" description="アプリ・サービスの状態と操作" />
      <AppsManager />
    </>
  );
}
