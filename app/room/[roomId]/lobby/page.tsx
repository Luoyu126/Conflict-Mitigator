import LobbyForm from "./_components/lobby-form";
export default async function LobbyPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  return <LobbyForm key={roomId} roomId={roomId} />;
}
