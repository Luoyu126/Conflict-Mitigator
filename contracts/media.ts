/** docs/api/frontend-api.md: LiveKitConnection (API-04 and API-05). */
export type LiveKitConnection = {
  serverUrl: string;
  participantToken: string;
  roomName: string;
  participantIdentity: string;
  expiresAt: string;
};

/** API-05 response data, inside the standard ApiResponse envelope. */
export type TokenData = {
  livekit: LiveKitConnection;
};
