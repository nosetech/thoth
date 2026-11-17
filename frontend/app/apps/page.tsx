import { PageHeading } from "@/components/PageHeading";
import { EmptyState } from "@/components/states";

export default function Page() {
  return (
    <>
      <PageHeading title="アプリ" />
      <EmptyState
        title="登録アプリがありません"
        description="この画面は今後の issue で実装します。"
      />
    </>
  );
}
