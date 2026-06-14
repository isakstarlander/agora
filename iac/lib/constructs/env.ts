import * as cdk from "aws-cdk-lib";

export interface AgoraContext {
  env: string;
  region: string;
  account: string;
  waf: boolean;
  bedrock: boolean;
  apiTiers: boolean;
  scheduleIntensity: "low" | "normal" | "high";
  rebuild: boolean;
  reembed: boolean;
  contactEmail: string;
  domain?: string;
  bedrockModels: string[];
  ratelimit: { llmRpm: number };
}

export function readContext(app: cdk.App): AgoraContext {
  const env = app.node.tryGetContext("agora:env") ?? "prod";
  const region =
    app.node.tryGetContext("agora:defaultRegion") ??
    process.env.CDK_DEFAULT_REGION ??
    "eu-north-1";
  const account = process.env.CDK_DEFAULT_ACCOUNT ?? "unknown";

  const contactEmail: string | undefined =
    app.node.tryGetContext("contactEmail");

  const defaultBedrockModels = [
    "arn:aws:bedrock:eu-north-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
    "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0",
  ];

  const rawModels = app.node.tryGetContext("bedrockModels");
  const bedrockModels: string[] =
    rawModels != null
      ? typeof rawModels === "string"
        ? JSON.parse(rawModels)
        : rawModels
      : defaultBedrockModels;

  const llmRpm = Number(
    app.node.tryGetContext("agora:ratelimit.llmRpm") ?? 2
  );

  const rawWaf = app.node.tryGetContext("agora:waf") ?? "on";
  const rawBedrock = app.node.tryGetContext("agora:bedrock") ?? "on";
  const rawApiTiers = app.node.tryGetContext("agora:apiTiers") ?? "off";
  const rawIntensity =
    app.node.tryGetContext("agora:scheduleIntensity") ?? "normal";

  return {
    env,
    region,
    account,
    waf: rawWaf !== "off" && rawWaf !== false,
    bedrock: rawBedrock !== "off" && rawBedrock !== false,
    apiTiers: rawApiTiers === "on" || rawApiTiers === true,
    scheduleIntensity: ["low", "normal", "high"].includes(rawIntensity)
      ? (rawIntensity as "low" | "normal" | "high")
      : "normal",
    rebuild:
      app.node.tryGetContext("agora:rebuild") === true ||
      app.node.tryGetContext("agora:rebuild") === "true",
    reembed:
      app.node.tryGetContext("agora:reembed") === true ||
      app.node.tryGetContext("agora:reembed") === "true",
    contactEmail: contactEmail ?? "",
    domain: app.node.tryGetContext("domain"),
    bedrockModels,
    ratelimit: { llmRpm },
  };
}
