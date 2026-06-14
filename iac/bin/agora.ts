import * as cdk from "aws-cdk-lib";
import { readContext } from "../lib/constructs/env";
import { AgoraDataStack } from "../lib/data-stack";
import { AgoraApiStack } from "../lib/api-stack";
import { AgoraLlmStack } from "../lib/llm-stack";
import { AgoraWebStack } from "../lib/web-stack";
import { AgoraObsStack } from "../lib/obs-stack";

const app = new cdk.App();
const ctx = readContext(app);

const prefix = ctx.env === "prod" ? "" : `${ctx.env}-`;
const stackProps = {
  env: { account: ctx.account, region: ctx.region },
  prefix,
  ctx,
  tags: { Project: "agora", Env: ctx.env, ManagedBy: "cdk" },
};

const data = new AgoraDataStack(app, `${prefix}AgoraDataStack`, stackProps);
const api = new AgoraApiStack(app, `${prefix}AgoraApiStack`, {
  ...stackProps,
  data,
});
const llm = new AgoraLlmStack(app, `${prefix}AgoraLlmStack`, {
  ...stackProps,
  data,
  api,
});
const web = new AgoraWebStack(app, `${prefix}AgoraWebStack`, {
  ...stackProps,
  api,
});
new AgoraObsStack(app, `${prefix}AgoraObsStack`, {
  ...stackProps,
  data,
  api,
  llm,
  web,
});

cdk.Tags.of(app).add("Project", "agora");
cdk.Tags.of(app).add("Env", ctx.env);
cdk.Tags.of(app).add("ManagedBy", "cdk");
