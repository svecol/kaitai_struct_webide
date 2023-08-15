﻿import { fss, IFsItem } from "./app.files";
import { performanceHelper } from "./utils/PerformanceHelper";
import KaitaiStructCompiler = require("kaitai-struct-compiler");

class SchemaUtils {
    static ksyNameToJsName(ksyName: string, isProp: boolean) {
        return ksyName.split("_").map((x, i) => i === 0 && isProp ? x : x.ucFirst()).join("");
    }

    static collectTypes(types: IKsyTypes, parent: KsySchema.IType) {
        if (parent.types) {
            parent.typesByJsName = {};
            Object.keys(parent.types).forEach(name => {
                var jsName = SchemaUtils.ksyNameToJsName(name, false);
                parent.typesByJsName[jsName] = types[jsName] = parent.types[name];
                SchemaUtils.collectTypes(types, parent.types[name]);
            });
        }

        if (parent.instances) {
            parent.instancesByJsName = {};
            Object.keys(parent.instances).forEach(name => {
                var jsName = SchemaUtils.ksyNameToJsName(name, true);
                parent.instancesByJsName[jsName] = parent.instances[name];
            });
        }
    }

    static collectKsyTypes(schema: KsySchema.IKsyFile): IKsyTypes {
        var types: IKsyTypes = {};
        SchemaUtils.collectTypes(types, schema);

        var typeName = SchemaUtils.ksyNameToJsName(schema.meta.id, false);
        types[typeName] = schema;

        return types;
    }
}

class JsImporter implements IYamlImporter {
    rootFsItem: IFsItem;

    async importYaml(name: string, mode: string) {
        var loadFn;
        var importedFsType = this.rootFsItem.fsType;
        if (mode === "abs") {
            loadFn = "formats/" + name;
            importedFsType = "kaitai";
        } else {
            var fnParts = this.rootFsItem.fn.split("/");
            fnParts.pop();
            loadFn = fnParts.join("/") + "/" + name;

            if (loadFn.startsWith("/")) {
                loadFn = loadFn.substr(1);
            }
        }

        console.log(`import yaml: ${name}, mode: ${mode}, loadFn: ${loadFn}, root:`, this.rootFsItem);
        let ksyContent = await fss[importedFsType].get(`${loadFn}.ksy`);
        var ksyModel = <KsySchema.IKsyFile>YAML.parse(<string>ksyContent);
        return ksyModel;
    }
}

export class CompilationError {
    constructor(public type: "yaml"|"kaitai", public error: any) { }
}

export class CompilerService {
    jsImporter = new JsImporter();
    ksySchema: KsySchema.IKsyFile;
    ksyTypes: IKsyTypes;

    compile(srcYamlFsItem: IFsItem, srcYaml: string, kslang: string, debug: true | false | "both"): Promise<any> {
        var perfYamlParse = performanceHelper.measureAction("YAML parsing");

        this.jsImporter.rootFsItem = srcYamlFsItem;

        try {
            this.ksySchema = <KsySchema.IKsyFile>YAML.parse(srcYaml);
            this.ksyTypes = SchemaUtils.collectKsyTypes(this.ksySchema);

            // we have to modify the schema (add typesByJsName for example) before sending into the compiler so we need a copy
            var compilerSchema = <KsySchema.IKsyFile>YAML.parse(srcYaml);
        } catch (parseErr) {
            return Promise.reject(new CompilationError("yaml", parseErr));
        }

        perfYamlParse.done();

        //console.log("ksySchema", ksySchema);

        if (kslang === "json")
            return Promise.resolve();
        else {
            var perfCompile = performanceHelper.measureAction("Compilation");

            var ks = new KaitaiStructCompiler();
            var rReleasePromise = (debug === false || debug === "both") ? ks.compile(kslang, compilerSchema, this.jsImporter, false) : Promise.resolve(null);
            var rDebugPromise = (debug === true || debug === "both") ? ks.compile(kslang, compilerSchema, this.jsImporter, true) : Promise.resolve(null);
            console.log("rReleasePromise", rReleasePromise, "rDebugPromise", rDebugPromise);
            return perfCompile.done(Promise.all([rReleasePromise, rDebugPromise]))
                .then(([rRelease, rDebug]) => {
                    function findPrototypeReadCode(inputCode: string): number[] {
                        const markerSting = ".prototype._read = function() {";
                        const startIndex = inputCode.indexOf(markerSting);
                
                        if (startIndex === -1) {
                          console.log("Pattern not found.");
                          return;
                        }
                      
                        let openBrackets = 1;
                        let currentIndex = startIndex + markerSting.length;
                      
                        while (currentIndex < inputCode.length && openBrackets > 0) {
                          if (inputCode[currentIndex] === "{") {
                            openBrackets++;
                          } else if (inputCode[currentIndex] === "}") {
                            openBrackets--;
                            if (openBrackets === 0) {
                              const endIndex = currentIndex;
                              const extractedCode = inputCode.substring(startIndex + markerSting.length, endIndex + 1);
                              console.log("Found code block:");
                              console.log(extractedCode);
                              return [startIndex + markerSting.length, endIndex];
                            }
                          }
                          currentIndex++;
                        }
                        console.log("No matching closing bracket found.");
                    }
                    
                    console.log("rDebug len", Object.keys(rDebug).length);
                    for (const key in rDebug) {       
                        // change rDebug[key]
                        // rDebug[key] = "// My injection!\n" + rDebug[key];
                        const bodyMargins = findPrototypeReadCode(rDebug[key]);
                        rDebug[key] = rDebug[key].substring(0, bodyMargins[0]) +
                                        "\ntry {\n" +
                                        rDebug[key].substring(bodyMargins[0], bodyMargins[1]) +
                                        "\n} catch {\nthis.fuck = 0x69;\n}\n" + 
                                        rDebug[key].substring(bodyMargins[1]);
                    }
                    return rRelease && rDebug ? { debug: rDebug, release: rRelease } : rRelease ? rRelease : rDebug;
                }).catch(compileErr => Promise.reject(new CompilationError("kaitai", compileErr)));
        }
    }
}
