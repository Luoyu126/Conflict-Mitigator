import AudioLab from "./audio-lab";
import Link from "next/link";

export default function Page() {
  return <><nav style={{ padding: "20px", textAlign: "center" }}><Link href="/emotion">打开 Hume 实时语音情绪测试 →</Link></nav><AudioLab /></>;
}
