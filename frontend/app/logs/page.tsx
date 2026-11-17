import { PageHeading } from "@/components/PageHeading";
import { EmptyState } from "@/components/states";

export default function Page() {
  return (
    <>
      <PageHeading title="ログ" />
      <EmptyState
        title="表示するログがありません"
        description="この画面は今後の issue で実装します。"
      />
    </>
  );
}
