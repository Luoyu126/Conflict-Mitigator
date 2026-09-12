import type { Metadata } from "next";
import "@livekit/components-styles";
import "./style.css";

export const metadata: Metadata = {
  title: "LiveKit 音视频实验室",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
