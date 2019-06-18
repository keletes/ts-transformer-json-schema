import * as ts from "typescript";

export default function transformer(program: ts.Program): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => (file: ts.SourceFile) => visitNodeAndChildren(file, program, context);
}

/**
 * TRANSFORMER LOGIC
 */

// tslint:disable-next-line:max-line-length
function visitNodeAndChildren(node: ts.SourceFile, program: ts.Program, context: ts.TransformationContext): ts.SourceFile;
function visitNodeAndChildren(node: ts.Node, program: ts.Program, context: ts.TransformationContext): ts.Node;

function visitNodeAndChildren(node: ts.Node, program: ts.Program, context: ts.TransformationContext): ts.Node {
  return ts.visitEachChild(visitNode(node, program), (childNode) =>
    visitNodeAndChildren(childNode, program, context), context);
}

function visitNode(node: ts.Node, program: ts.Program): ts.Node {
  const typeChecker = program.getTypeChecker();

  if (!isKeysCallExpression(node, typeChecker)) {
    return node;
  }
  if (!node.typeArguments) {
    return ts.createObjectLiteral();
  }

  const type = typeChecker.getTypeFromTypeNode(node.typeArguments[0]);
  return parseType(type, typeChecker, []);
}

function isKeysCallExpression(node: ts.Node, typeChecker: ts.TypeChecker): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) { return false; }

  const signature = typeChecker.getResolvedSignature(node);
  if (typeof signature === "undefined") { return false; }
  
  const { declaration } = signature;
  return !!declaration
    && !ts.isJSDocSignature(declaration)
    && !!declaration.name
    && declaration.name!.getText() === "schema";
}

/**
 * PARSING LOGIC
 */
function parseType(type: ts.Type, tc: ts.TypeChecker, history?: string[]): ts.ObjectLiteralExpression {

  const flags = type.flags;

  if (flags & ts.TypeFlags.StringLike ||
    flags & ts.TypeFlags.NumberLike ||
    flags & ts.TypeFlags.BooleanLike ||
    flags === ts.TypeFlags.Any) {
    return parsePrimitive(type, tc);
  }

  if (flags === ts.TypeFlags.Null ||
    flags === ts.TypeFlags.Undefined) {
    return ts.createObjectLiteral();
  }

  if (flags === ts.TypeFlags.Object) {
    let objectType: ts.ObjectType = type as ts.ObjectType;

    if (objectType.objectFlags === ts.ObjectFlags.Interface) {
      return parseInterface(type, tc);
    }

    if (objectType.objectFlags === ts.ObjectFlags.Reference) {
      return parseArray(type, tc);
    }
  }

  if (flags === ts.TypeFlags.Union) {
    return parseUnion(type, tc);
  }

  if (flags === ts.TypeFlags.Intersection) {
    return parseIntersection(type, tc);
  }

  if (flags & ts.TypeFlags.EnumLike) {
    return parseEnum(type, tc);
  }

  return ts.createObjectLiteral();
}

function parsePrimitive(type: ts.Type, tc: ts.TypeChecker): ts.ObjectLiteralExpression {
  const type_string = tc.typeToString(type);
  return ts.createObjectLiteral([
    ts.createPropertyAssignment("type", ts.createLiteral(type_string))
  ]);
}

function parseEnum(type: ts.Type, tc: ts.TypeChecker): ts.ObjectLiteralExpression {
  const enum_type = type as ts.UnionOrIntersectionType;
  const values = enum_type.types.map( enum_property => {
    return ts.createLiteral(enum_property['value']);
  });

  return ts.createObjectLiteral([
    ts.createPropertyAssignment("type", ts.createLiteral("enum")),
    ts.createPropertyAssignment("values", ts.createArrayLiteral(values))
  ]);
}

function parseArray(type: ts.Type, tc: ts.TypeChecker): ts.ObjectLiteralExpression {
  return ts.createObjectLiteral([
    ts.createPropertyAssignment("type", ts.createLiteral("array"))
  ]);
}

function parseUnion(type: ts.Type, tc: ts.TypeChecker): ts.ObjectLiteralExpression {
  const union_type = type as ts.UnionOrIntersectionType;
  const types = union_type.types.filter(union_property => tc.typeToString(union_property) !== 'undefined')
  .map( union_property => {
    if(union_property.flags & ts.TypeFlags.BooleanLiteral){
      return ts.createObjectLiteral([
        ts.createPropertyAssignment("type", ts.createLiteral("boolean"))
      ]);
    }

    return parseType(union_property, tc);
  });

  

  return ts.createArrayLiteral(types) as unknown as ts.ObjectLiteralExpression;
}

function parseIntersection(type: ts.Type, tc: ts.TypeChecker): ts.ObjectLiteralExpression {
  const intersection_type = type as ts.UnionOrIntersectionType;
  const types = intersection_type.types.map( intersection_property => {
    return parseType(intersection_property, tc);
  });

  const combined_properties: ts.ObjectLiteralElementLike[] = [];
  types.forEach( type => {
      type.properties.forEach(property => combined_properties.push(property))
  });

  return ts.createObjectLiteral(combined_properties);
}

function parseInterface(type: ts.Type, tc: ts.TypeChecker): ts.ObjectLiteralExpression {
  const properties = tc.getPropertiesOfType(type).filter((property) => property.declarations!.length);

  const properties_assignments = properties.map( property => {
    let parsed = parseType(tc.getTypeOfSymbolAtLocation(property, property.declarations![0]), tc);
 
    const declaration: ts.ParameterDeclaration = property.declarations[0] as ts.ParameterDeclaration;
    if(declaration.questionToken && parsed.properties){

      const combined_properties: ts.ObjectLiteralElementLike[] = [];
      parsed.properties.forEach( property => combined_properties.push(property));

      combined_properties.push(ts.createPropertyAssignment("optional", ts.createLiteral(true)));
      parsed = ts.createObjectLiteral(combined_properties);
    }

    const docs = property.getJsDocTags();
    if(docs.length && parsed.properties){
      docs.forEach( doc => {
        if(doc.text){
          const combined_properties: ts.ObjectLiteralElementLike[] = [];
          parsed.properties.forEach( property => combined_properties.push(property));

          let value: any = doc.text;
          if(doc.text === "true"){
            value = true;
          }

          if(doc.text === "false"){
            value = false;
          }

          if(/^\d+$/.test(doc.text)){
            value = parseInt(doc.text);
          }
  
          combined_properties.push(ts.createPropertyAssignment(doc.name, ts.createLiteral(value)));
          parsed = ts.createObjectLiteral(combined_properties);
        }
      });
    }

    return ts.createPropertyAssignment(property.name, parsed);
  })

  return ts.createObjectLiteral(properties_assignments); 
}