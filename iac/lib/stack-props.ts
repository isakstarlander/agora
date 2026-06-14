import * as cdk from "aws-cdk-lib";
import { AgoraContext } from "./constructs/env";

export interface AgoraStackProps extends cdk.StackProps {
  prefix: string;
  ctx: AgoraContext;
  tags: Record<string, string>;
}
