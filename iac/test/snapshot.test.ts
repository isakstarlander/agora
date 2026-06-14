import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { AgoraContext } from "../lib/constructs/env";
import { AgoraDataStack } from "../lib/data-stack";
import { AgoraApiStack } from "../lib/api-stack";
import { AgoraLlmStack } from "../lib/llm-stack";
import { AgoraWebStack } from "../lib/web-stack";
import { AgoraObsStack } from "../lib/obs-stack";

const TEST_ACCOUNT = "111111111111";
const TEST_REGION = "eu-north-1";

const ctx: AgoraContext = {
  env: "prod",
  region: TEST_REGION,
  account: TEST_ACCOUNT,
  waf: true,
  bedrock: true,
  apiTiers: false,
  scheduleIntensity: "normal",
  rebuild: false,
  reembed: false,
  contactEmail: "test@example.com",
  bedrockModels: [
    "arn:aws:bedrock:eu-north-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0",
    "arn:aws:bedrock:eu-north-1::foundation-model/amazon.titan-embed-text-v2:0",
  ],
  ratelimit: { llmRpm: 2 },
};

const stackEnv = { account: TEST_ACCOUNT, region: TEST_REGION };
const stackProps = { env: stackEnv, prefix: "", ctx, tags: {} };

function makeApp(): cdk.App {
  return new cdk.App({
    context: { "agora:env": "prod", contactEmail: "test@example.com" },
  });
}

test("DataStack synthesises without error", () => {
  const app = makeApp();
  const stack = new AgoraDataStack(app, "AgoraDataStack", stackProps);
  const tmpl = Template.fromStack(stack);
  expect(tmpl.toJSON()).toMatchSnapshot();

  tmpl.resourceCountIs("AWS::S3::Bucket", 3);
  tmpl.resourceCountIs("AWS::DynamoDB::Table", 6);
  tmpl.hasResourceProperties(
    "AWS::DynamoDB::Table",
    Match.objectLike({ TimeToLiveSpecification: { AttributeName: "expires_at", Enabled: true } })
  );
  tmpl.hasResource("AWS::S3::Bucket", Match.objectLike({
    DeletionPolicy: "Retain",
    Properties: Match.objectLike({ BucketName: Match.stringLikeRegexp("agora-parquet-") }),
  }));
});

test("ApiStack synthesises without error", () => {
  const app = makeApp();
  const data = new AgoraDataStack(app, "AgoraDataStack", stackProps);
  const stack = new AgoraApiStack(app, "AgoraApiStack", {
    ...stackProps,
    data,
  });
  const tmpl = Template.fromStack(stack);
  expect(tmpl.toJSON()).toMatchSnapshot();
});

test("LlmStack synthesises without error", () => {
  const app = makeApp();
  const data = new AgoraDataStack(app, "AgoraDataStack", stackProps);
  const api = new AgoraApiStack(app, "AgoraApiStack", { ...stackProps, data });
  const stack = new AgoraLlmStack(app, "AgoraLlmStack", {
    ...stackProps,
    data,
    api,
  });
  const tmpl = Template.fromStack(stack);
  expect(tmpl.toJSON()).toMatchSnapshot();
});

test("WebStack synthesises without error", () => {
  const app = makeApp();
  const data = new AgoraDataStack(app, "AgoraDataStack", stackProps);
  const api = new AgoraApiStack(app, "AgoraApiStack", { ...stackProps, data });
  const stack = new AgoraWebStack(app, "AgoraWebStack", {
    ...stackProps,
    api,
  });
  const tmpl = Template.fromStack(stack);
  expect(tmpl.toJSON()).toMatchSnapshot();
});

test("ObsStack synthesises without error", () => {
  const app = makeApp();
  const data = new AgoraDataStack(app, "AgoraDataStack", stackProps);
  const api = new AgoraApiStack(app, "AgoraApiStack", { ...stackProps, data });
  const llm = new AgoraLlmStack(app, "AgoraLlmStack", {
    ...stackProps,
    data,
    api,
  });
  const web = new AgoraWebStack(app, "AgoraWebStack", { ...stackProps, api });
  const stack = new AgoraObsStack(app, "AgoraObsStack", {
    ...stackProps,
    data,
    api,
    llm,
    web,
  });
  const tmpl = Template.fromStack(stack);
  expect(tmpl.toJSON()).toMatchSnapshot();
});
