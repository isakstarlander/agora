import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { AgoraStackProps } from "./stack-props";
import { AgoraApiStack } from "./api-stack";

export interface AgoraWebStackProps extends AgoraStackProps {
  api: AgoraApiStack;
}

export class AgoraWebStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgoraWebStackProps) {
    super(scope, id, props);

    new cdk.CfnOutput(this, "StackIdMarker", {
      value: this.stackName,
      description: "Agora stack marker",
    });
  }
}
