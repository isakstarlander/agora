import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { AgoraStackProps } from "./stack-props";
import { AgoraDataStack } from "./data-stack";
import { AgoraApiStack } from "./api-stack";

export interface AgoraLlmStackProps extends AgoraStackProps {
  data: AgoraDataStack;
  api: AgoraApiStack;
}

export class AgoraLlmStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgoraLlmStackProps) {
    super(scope, id, props);

    new cdk.CfnOutput(this, "StackIdMarker", {
      value: this.stackName,
      description: "Agora stack marker",
    });
  }
}
