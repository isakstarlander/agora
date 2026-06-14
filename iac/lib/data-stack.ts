import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { AgoraStackProps } from "./stack-props";

export class AgoraDataStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgoraStackProps) {
    super(scope, id, props);

    new cdk.CfnOutput(this, "StackIdMarker", {
      value: this.stackName,
      description: "Agora stack marker",
    });
  }
}
