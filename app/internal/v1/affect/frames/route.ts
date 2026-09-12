import { requireServiceToken } from "../../../../../lib/server/auth.ts";
import { routeResponse, successResponse } from "../../../../../lib/server/http.ts";
import { ApiProblem } from "../../../../../lib/server/errors.ts";
import { frameMetadataSchema } from "../../../../../contracts/affect.ts";
import { MAX_FACE_JPEG_BYTES, readBoundedBody } from "../../../../../lib/affect/face.ts";
import { analyzeFaceFrame } from "../../../../../lib/integrations/faceplus.ts";

export const runtime = "nodejs";
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_MULTIPART_BYTES = MAX_FACE_JPEG_BYTES + MAX_METADATA_BYTES + 16 * 1024;

export async function POST(request: Request): Promise<Response> {
  return routeResponse(async (requestId) => {
    // This is the existing Worker → inference service endpoint, never a browser
    // upload route. Authenticate before touching any attacker-controlled body.
    requireServiceToken(request, "INFERENCE_SERVICE_TOKEN");
    const contentType = request.headers.get("content-type") ?? "";
    if (!/^multipart\/form-data\s*;/i.test(contentType)) {
      throw new ApiProblem({ status: 415, code: "INVALID_REQUEST", message: "A multipart frame upload is required." });
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]);
    const bytes = await readBoundedBody(request.body, MAX_MULTIPART_BYTES, signal);
    let form: FormData;
    try { form = await new Response(Uint8Array.from(bytes), { headers: { "Content-Type": contentType } }).formData(); }
    catch { throw new ApiProblem({ status: 400, code: "INVALID_REQUEST", message: "The multipart body is malformed." }); }
    if ([...form.keys()].length !== 2 || form.getAll("metadata").length !== 1 || form.getAll("frame").length !== 1) {
      throw new ApiProblem({ status: 422, code: "VALIDATION_ERROR", message: "Exactly one metadata part and one JPEG frame are required." });
    }
    const metadataPart = form.get("metadata");
    const framePart = form.get("frame");
    if (!(metadataPart instanceof Blob) || metadataPart.type !== "application/json" || metadataPart.size > MAX_METADATA_BYTES
        || !(framePart instanceof Blob) || framePart.type !== "image/jpeg") {
      throw new ApiProblem({ status: 422, code: "VALIDATION_ERROR", message: "Metadata must be an application/json part and frame must be image/jpeg." });
    }
    if (framePart.size > MAX_FACE_JPEG_BYTES) throw new ApiProblem({ status: 413, code: "PAYLOAD_TOO_LARGE", message: "The JPEG frame exceeds 512 KiB." });
    let value: unknown;
    try { value = JSON.parse(await metadataPart.text()); }
    catch { throw new ApiProblem({ status: 422, code: "VALIDATION_ERROR", message: "Frame metadata must be valid JSON." }); }
    const metadata = frameMetadataSchema.safeParse(value);
    if (!metadata.success) throw new ApiProblem({ status: 422, code: "VALIDATION_ERROR", message: "Frame metadata does not match the inference contract." });
    const result = await analyzeFaceFrame(new Uint8Array(await framePart.arrayBuffer()), metadata.data, { signal });
    return successResponse(result, { requestId });
  });
}
