import { NextRequest, NextResponse } from "next/server";

export const OPENAI_URL = "api.openai.com";
const DEFAULT_PROTOCOL = "https";
const PROTOCOL = process.env.PROTOCOL ?? DEFAULT_PROTOCOL;
const BASE_URL = process.env.BASE_URL ?? OPENAI_URL;
const DISABLE_GPT4 = !!process.env.DISABLE_GPT4;

export async function requestOpenai(req: NextRequest) {
  const clonedReq = req.clone();
  const controller = new AbortController();
  const authValue = clonedReq.headers.get("Authorization") ?? "";
  const openaiPath = `${req.nextUrl.pathname}${req.nextUrl.search}`.replaceAll(
    "/api/openai/",
    "",
  );

  let baseUrl = BASE_URL;

  if (!baseUrl.startsWith("http")) {
    baseUrl = `${PROTOCOL}://${baseUrl}`;
  }

  console.log("[Proxy] ", openaiPath);
  console.log("[Base Url]", baseUrl);

  if (process.env.OPENAI_ORG_ID) {
    console.log("[Org ID]", process.env.OPENAI_ORG_ID);
  }

  const reqJson = JSON.parse(await req.text());
  const requstTrackId = Math.floor(Math.random() * 100) + 1;
  const latestQuestion = reqJson.messages[reqJson.messages.length - 1].content;
  console.log("[Ask " + requstTrackId + "] " + latestQuestion);

  const timeoutId = setTimeout(() => {
    controller.abort();
  }, 10 * 60 * 1000);

  const fetchUrl = `${baseUrl}/${openaiPath}`;
  const fetchOptions: RequestInit = {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Authorization: authValue,
      ...(process.env.OPENAI_ORG_ID && {
        "OpenAI-Organization": process.env.OPENAI_ORG_ID,
      }),
    },
    method: clonedReq.method,
    body: clonedReq.body,
    // @ts-ignore
    duplex: "half",
    signal: controller.signal,
  };

  // #1815 try to refuse gpt4 request
  if (DISABLE_GPT4 && clonedReq.body) {
    try {
      const clonedBody = await clonedReq.text();
      fetchOptions.body = clonedBody;

      const jsonBody = JSON.parse(clonedBody);

      if ((jsonBody?.model ?? "").includes("gpt-4")) {
        return NextResponse.json(
          {
            error: true,
            message: "you are not allowed to use gpt-4 model",
          },
          {
            status: 403,
          },
        );
      }
    } catch (e) {
      console.error("[OpenAI] gpt4 filter", e);
    }
  }

  try {
    const res = await fetch(fetchUrl, fetchOptions);
    const clonedRes = res.clone();

    // to prevent browser prompt for credentials
    const newHeaders = new Headers(res.headers);
    newHeaders.delete("www-authenticate");

    // to disable nginx buffering
    newHeaders.set("X-Accel-Buffering", "no");

    let responseText = "";
    // Create a new ReadableStream that logs the data as it's read
    const loggingStream = new ReadableStream({
      start(controller) {
        const reader = clonedRes.body!.getReader();

        function push() {
          reader.read().then(({ done, value }) => {
            if (done) {
              controller.close();

              const dataArray: string[] = responseText.trim().split("\n");

              // Array to store the extracted delta.content values
              const deltaContents: string[] = [];

              // Loop through the data and extract delta.content values
              dataArray.forEach((jsonString) => {
                const deltaContent = getDeltaContent(
                  jsonString.substring(6).trim(),
                );
                if (deltaContent !== null) {
                  deltaContents.push(deltaContent);
                }
              });

              // Output the extracted delta.content values
              deltaContents.shift(); // Remove the first element
              deltaContents.pop(); // Remove the last element

              // Convert the deltaContents array to a string
              const deltaContentsString = deltaContents.join("");

              // Output the deltaContentsString
              console.log(
                "[Answer " + requstTrackId + "] " + deltaContentsString,
              );
              return;
            }

            responseText += new TextDecoder("UTF-8").decode(value);
            controller.enqueue(value);
            push();
          });
        }

        push();
      },
    });

    return new Response(loggingStream, {
      status: clonedRes.status,
      statusText: clonedRes.statusText,
      headers: newHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function getDeltaContent(jsonString: string) {
  if (!jsonString.startsWith("{")) {
    return null;
  }
  try {
    const obj = JSON.parse(jsonString);
    if (obj && obj.choices && obj.choices.length > 0) {
      return obj.choices[0].delta.content;
    }
  } catch (error) {
    console.error("Error parsing JSON:", error);
  }
  return null;
}
