import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { AgoraStackProps } from "./stack-props";
import { AgoraDataStack } from "./data-stack";
import { AgoraApiStack } from "./api-stack";
import { AgoraLlmStack } from "./llm-stack";
import { AgoraWebStack } from "./web-stack";

export interface AgoraObsStackProps extends AgoraStackProps {
  data: AgoraDataStack;
  api: AgoraApiStack;
  llm: AgoraLlmStack;
  web: AgoraWebStack;
}

export class AgoraObsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgoraObsStackProps) {
    super(scope, id, props);

    new cdk.CfnOutput(this, "StackIdMarker", {
      value: this.stackName,
      description: "Agora stack marker",
    });
  }
}
