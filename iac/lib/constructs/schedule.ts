import * as iam from "aws-cdk-lib/aws-iam";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";

export interface LambdaScheduleProps {
  scheduleName: string;
  /** Cron expression, e.g. "cron(0 6 * * ? *)" */
  cronExpression: string;
  target: lambda.IFunction;
  /** Input payload forwarded to the Lambda; defaults to empty object */
  input?: string;
  /** EventBridge Scheduler group name; defaults to default group */
  groupName?: string;
}

export class LambdaSchedule extends Construct {
  constructor(scope: Construct, id: string, props: LambdaScheduleProps) {
    super(scope, id);

    const { scheduleName, cronExpression, target, input = "{}", groupName } = props;

    const role = new iam.Role(this, "InvokeRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["lambda:InvokeFunction"],
        resources: [target.functionArn],
      })
    );

    new scheduler.CfnSchedule(this, "Schedule", {
      name: scheduleName,
      groupName,
      scheduleExpression: cronExpression,
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: target.functionArn,
        roleArn: role.roleArn,
        input,
      },
    });
  }
}
