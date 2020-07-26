import ts from 'typescript';

export type FuncSplit = {
  originalName: string;
  rawLambdaName: string;
  arity: number;
};

const deriveRawLambdaName = (wrappedName: string): string =>
  wrappedName + '_raw';

const wrapperRegex = /F(?<arity>[1-9]+[0-9]*)/;

export const createSplitFunctionDeclarationsTransformer = (
  reportSplit: (split: FuncSplit) => void
): ts.TransformerFactory<ts.SourceFile> => context => {
  return sourceFile => {
    const visitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
      // detects "var a"
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        // detects "var a = [exp](..)"
        if (node.initializer && ts.isCallExpression(node.initializer)) {
          const callExpression = node.initializer.expression;
          // detects "var a = f(..)"
          if (ts.isIdentifier(callExpression)) {
            // detects "var a = F123(..)"
            const maybeMatch = callExpression.text.match(wrapperRegex);
            if (maybeMatch && maybeMatch.groups) {
              const args = node.initializer.arguments;
              // checks that it should be called with only one argument
              if (args.length === 1) {
                const [maybeFuncExpression] = args;

                // and it is a function
                // detects "var a = F123( function (a) {return a})"
                // or "var a = F123( a => a)"
                if (
                  ts.isArrowFunction(maybeFuncExpression) ||
                  ts.isFunctionExpression(maybeFuncExpression)
                ) {
                  // TODO typecheck?
                  const arity = Number(maybeMatch.groups.arity);
                  const originalName = node.name.text;
                  const rawLambdaName = deriveRawLambdaName(originalName);

                  reportSplit({ arity, originalName, rawLambdaName });

                  const lambdaDeclaration = ts.createVariableDeclaration(
                    rawLambdaName,
                    undefined,
                    maybeFuncExpression
                  );

                  const newDeclaration = ts.updateVariableDeclaration(
                    node,
                    node.name,
                    node.type,
                    ts.createCall(callExpression, undefined, [
                      ts.createIdentifier(rawLambdaName),
                    ])
                  );

                  return [lambdaDeclaration, newDeclaration];
                }
              }
            }
          }
        }
      }

      return ts.visitEachChild(node, visitor, context);
    };

    return ts.visitNode(sourceFile, visitor);
  };
};

const invocationRegex = /A(?<arity>[1-9]+[0-9]*)/;

export const createFuncInlineTransformer = (
  splits: FuncSplit[]
): ts.TransformerFactory<ts.SourceFile> => context => {
  return sourceFile => {
    const visitor = (node: ts.Node): ts.VisitResult<ts.Node> => {
      // detects [exp](..)
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        // detects f(..)
        if (ts.isIdentifier(expression)) {
          const maybeMatch = expression.text.match(invocationRegex);
          // detects A123(...)
          if (maybeMatch && maybeMatch.groups) {
            const arity = Number(maybeMatch.groups.arity);

            const allArgs = node.arguments;
            const [funcName, ...args] = allArgs;

            if (!ts.isIdentifier(funcName)) {
              throw new Error(
                `first argument of A${arity} call is not an identifier`
              );
            }

            if (args.length !== arity) {
              throw new Error(
                `somerhing went wrong, expected number of arguments=${arity} but got ${args.length} for ${funcName.text}`
              );
            }

            const split = splits.find(s => s.originalName === funcName.text);

            if (split && split.arity === arity) {
              return ts.createCall(
                ts.createIdentifier(split.rawLambdaName),
                undefined,
                args
              );
            }
          }
        }
      }

      return ts.visitEachChild(node, visitor, context);
    };

    return ts.visitNode(sourceFile, visitor);
  };
};