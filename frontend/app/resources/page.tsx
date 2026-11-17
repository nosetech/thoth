import { PageHeading } from "@/components/PageHeading";
import { EmptyState } from "@/components/states";

export default function Page() {
  return (
    <>
      <PageHeading title="リソース" />
      <EmptyState
        title="リソース情報がありません"
        description="この画面は今後の issue で実装します。"
      />
    </>
  );
}
