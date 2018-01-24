import * as utils from "../../utils/utils"
import {
    contains,
    every,
    findAll,
    flatten,
    forEach,
    groupBy,
    isEmpty,
    map,
    pick,
    reduce,
    reject,
    values
} from "../../utils/utils"
import {
    IgnoredParserIssues,
    IParserAmbiguousAlternativesDefinitionError,
    IParserDefinitionError,
    IParserDuplicatesDefinitionError,
    IParserEmptyAlternativeDefinitionError,
    ParserDefinitionErrorType
} from "../parser_public"
import { getProductionDslName, isOptionalProd } from "./gast/gast"
import { tokenLabel, tokenName } from "../../scan/tokens_public"
import {
    Alternative,
    containsPath,
    getLookaheadPathsForOptionalProd,
    getLookaheadPathsForOr,
    getProdType,
    isStrictPrefixOfPath
} from "./lookahead"
import { VERSION } from "../../version"
import { TokenType } from "../../scan/lexer_public"
import { NamedDSLMethodsCollectorVisitor } from "../cst/cst"
import { nextPossibleTokensAfter } from "./interpreter"
import {
    Alternation,
    Flat,
    IOptionallyNamedProduction,
    IProduction,
    IProductionWithOccurrence,
    NonTerminal,
    Option,
    Repetition,
    RepetitionMandatory,
    RepetitionMandatoryWithSeparator,
    RepetitionWithSeparator,
    Rule,
    Terminal
} from "./gast/gast_public"
import { GAstVisitor } from "./gast/gast_visitor_public"
import {
    defaultGrammarErrorProvider,
    IGrammarErrorMessageProvider
} from "../errors_public"

export function validateGrammar(
    topLevels: Rule[],
    maxLookahead: number,
    tokens: TokenType[],
    ignoredIssues: IgnoredParserIssues,
    errMsgProvider: IGrammarErrorMessageProvider = defaultGrammarErrorProvider
): IParserDefinitionError[] {
    let duplicateErrors: any = utils.map(topLevels, currTopLevel =>
        validateDuplicateProductions(currTopLevel, errMsgProvider)
    )
    let leftRecursionErrors: any = utils.map(topLevels, currTopRule =>
        validateNoLeftRecursion(currTopRule, currTopRule)
    )

    let emptyAltErrors = []
    let ambiguousAltsErrors = []

    // left recursion could cause infinite loops in the following validations.
    // It is safest to first have the user fix the left recursion errors first and only then examine farther issues.
    if (every(leftRecursionErrors, isEmpty)) {
        emptyAltErrors = map(topLevels, validateEmptyOrAlternative)
        ambiguousAltsErrors = map(topLevels, currTopRule =>
            validateAmbiguousAlternationAlternatives(
                currTopRule,
                maxLookahead,
                ignoredIssues
            )
        )
    }

    let ruleNames = map(topLevels, currTopLevel => currTopLevel.name)
    let tokenNames = map(tokens, currToken => tokenName(currToken))
    let termsNamespaceConflictErrors = checkTerminalAndNoneTerminalsNameSpace(
        ruleNames,
        tokenNames
    )

    let tokenNameErrors: any = utils.map(tokenNames, validateTokenName)
    let nestedRulesNameErrors: any = validateNestedRulesNames(
        topLevels,
        errMsgProvider
    )
    let nestedRulesDuplicateErrors: any = validateDuplicateNestedRules(
        topLevels,
        errMsgProvider
    )

    let emptyRepetitionErrors = validateSomeNonEmptyLookaheadPath(
        topLevels,
        maxLookahead
    )

    const tooManyAltsErrors = utils.map(topLevels, validateTooManyAlts)

    return <any>utils.flatten(
        duplicateErrors.concat(
            tokenNameErrors,
            nestedRulesNameErrors,
            nestedRulesDuplicateErrors,
            emptyRepetitionErrors,
            leftRecursionErrors,
            emptyAltErrors,
            ambiguousAltsErrors,
            termsNamespaceConflictErrors,
            tooManyAltsErrors
        )
    )
}

function validateNestedRulesNames(
    topLevels: Rule[],
    errMsgProvider: IGrammarErrorMessageProvider
): IParserDefinitionError[] {
    let result = []
    forEach(topLevels, curTopLevel => {
        let namedCollectorVisitor = new NamedDSLMethodsCollectorVisitor("")
        curTopLevel.accept(namedCollectorVisitor)
        let nestedProds = map(
            namedCollectorVisitor.result,
            currItem => currItem.orgProd
        )
        result.push(
            map(nestedProds, currNestedProd =>
                validateNestedRuleName(
                    curTopLevel,
                    currNestedProd,
                    errMsgProvider
                )
            )
        )
    })

    return <any>flatten(result)
}

function validateDuplicateProductions(
    topLevelRule: Rule,
    errMsgProvider: IGrammarErrorMessageProvider
): IParserDuplicatesDefinitionError[] {
    let collectorVisitor = new OccurrenceValidationCollector()
    topLevelRule.accept(collectorVisitor)
    let allRuleProductions = collectorVisitor.allProductions

    let productionGroups = utils.groupBy(
        allRuleProductions,
        identifyProductionForDuplicates
    )

    let duplicates: any = utils.pick(productionGroups, currGroup => {
        return currGroup.length > 1
    })

    let errors = utils.map(utils.values(duplicates), (currDuplicates: any) => {
        let firstProd: any = utils.first(currDuplicates)
        let msg = errMsgProvider.buildDuplicateFoundError(
            topLevelRule,
            currDuplicates
        )
        let dslName = getProductionDslName(firstProd)
        let defError: IParserDuplicatesDefinitionError = {
            message: msg,
            type: ParserDefinitionErrorType.DUPLICATE_PRODUCTIONS,
            ruleName: topLevelRule.name,
            dslName: dslName,
            occurrence: firstProd.idx
        }

        let param = getExtraProductionArgument(firstProd)
        if (param) {
            defError.parameter = param
        }

        return defError
    })
    return errors
}

export function identifyProductionForDuplicates(
    prod: IProductionWithOccurrence
): string {
    return `${getProductionDslName(prod)}_#_${
        prod.idx
    }_#_${getExtraProductionArgument(prod)}`
}

function getExtraProductionArgument(prod: IProductionWithOccurrence): string {
    if (prod instanceof Terminal) {
        return tokenName(prod.terminalType)
    } else if (prod instanceof NonTerminal) {
        return prod.nonTerminalName
    } else {
        return ""
    }
}

export class OccurrenceValidationCollector extends GAstVisitor {
    public allProductions: IProduction[] = []

    public visitNonTerminal(subrule: NonTerminal): void {
        this.allProductions.push(subrule)
    }

    public visitOption(option: Option): void {
        this.allProductions.push(option)
    }

    public visitRepetitionWithSeparator(
        manySep: RepetitionWithSeparator
    ): void {
        this.allProductions.push(manySep)
    }

    public visitRepetitionMandatory(atLeastOne: RepetitionMandatory): void {
        this.allProductions.push(atLeastOne)
    }

    public visitRepetitionMandatoryWithSeparator(
        atLeastOneSep: RepetitionMandatoryWithSeparator
    ): void {
        this.allProductions.push(atLeastOneSep)
    }

    public visitRepetition(many: Repetition): void {
        this.allProductions.push(many)
    }

    public visitAlternation(or: Alternation): void {
        this.allProductions.push(or)
    }

    public visitTerminal(terminal: Terminal): void {
        this.allProductions.push(terminal)
    }
}

export const validTermsPattern = /^[a-zA-Z_]\w*$/
export const validNestedRuleName = new RegExp(
    validTermsPattern.source.replace("^", "^\\$")
)

// TODO: handle this validation in the analysis phase?
export function validateRuleName(ruleName: string): IParserDefinitionError[] {
    let errors = []
    let errMsg

    if (!ruleName.match(validTermsPattern)) {
        errMsg = `Invalid grammar rule name: ->${ruleName}<- it must match the pattern: ->${validTermsPattern.toString()}<-`
        errors.push({
            message: errMsg,
            type: ParserDefinitionErrorType.INVALID_RULE_NAME,
            ruleName: ruleName
        })
    }

    return errors
}

export function validateNestedRuleName(
    topLevel: Rule,
    nestedProd: IOptionallyNamedProduction,
    errMsgProvider: IGrammarErrorMessageProvider
): IParserDefinitionError[] {
    let errors = []
    let errMsg

    if (!nestedProd.name.match(validNestedRuleName)) {
        errMsg = errMsgProvider.buildInvalidNestedRuleNameError(
            topLevel,
            nestedProd
        )
        errors.push({
            message: errMsg,
            type: ParserDefinitionErrorType.INVALID_NESTED_RULE_NAME,
            ruleName: topLevel.name
        })
    }

    return errors
}

export function validateTokenName(tokenNAme: string): IParserDefinitionError[] {
    let errors = []
    let errMsg

    if (!tokenNAme.match(validTermsPattern)) {
        errMsg = `Invalid Grammar Token name: ->${tokenNAme}<- it must match the pattern: ->${validTermsPattern.toString()}<-`
        errors.push({
            message: errMsg,
            type: ParserDefinitionErrorType.INVALID_TOKEN_NAME
        })
    }

    return errors
}

export function validateRuleDoesNotAlreadyExist(
    ruleName: string,
    definedRulesNames: string[],
    className
): IParserDefinitionError[] {
    let errors = []
    let errMsg

    if (utils.contains(definedRulesNames, ruleName)) {
        errMsg = `Duplicate definition, rule: ->${ruleName}<- is already defined in the grammar: ->${className}<-`
        errors.push({
            message: errMsg,
            type: ParserDefinitionErrorType.DUPLICATE_RULE_NAME,
            ruleName: ruleName
        })
    }

    return errors
}

// TODO: is there anyway to get only the rule names of rules inherited from the super grammars?
export function validateRuleIsOverridden(
    ruleName: string,
    definedRulesNames: string[],
    className
): IParserDefinitionError[] {
    let errors = []
    let errMsg

    if (!utils.contains(definedRulesNames, ruleName)) {
        errMsg =
            `Invalid rule override, rule: ->${ruleName}<- cannot be overridden in the grammar: ->${className}<-` +
            `as it is not defined in any of the super grammars `
        errors.push({
            message: errMsg,
            type: ParserDefinitionErrorType.INVALID_RULE_OVERRIDE,
            ruleName: ruleName
        })
    }

    return errors
}

export function validateNoLeftRecursion(
    topRule: Rule,
    currRule: Rule,
    path: Rule[] = []
): IParserDefinitionError[] {
    let errors = []
    let nextNonTerminals = getFirstNoneTerminal(currRule.definition)
    if (utils.isEmpty(nextNonTerminals)) {
        return []
    } else {
        let ruleName = topRule.name
        let foundLeftRecursion = utils.contains(<any>nextNonTerminals, topRule)
        let pathNames = utils.map(path, currRule => currRule.name)
        let leftRecursivePath = `${ruleName} --> ${pathNames
            .concat([ruleName])
            .join(" --> ")}`
        if (foundLeftRecursion) {
            let errMsg =
                `Left Recursion found in grammar.\n` +
                `rule: <${ruleName}> can be invoked from itself (directly or indirectly)\n` +
                `without consuming any Tokens. The grammar path that causes this is: \n ${leftRecursivePath}\n` +
                ` To fix this refactor your grammar to remove the left recursion.\n` +
                `see: https://en.wikipedia.org/wiki/LL_parser#Left_Factoring.`
            errors.push({
                message: errMsg,
                type: ParserDefinitionErrorType.LEFT_RECURSION,
                ruleName: ruleName
            })
        }

        // we are only looking for cyclic paths leading back to the specific topRule
        // other cyclic paths are ignored, we still need this difference to avoid infinite loops...
        let validNextSteps = utils.difference(
            nextNonTerminals,
            path.concat([topRule])
        )
        let errorsFromNextSteps = utils.map(validNextSteps, currRefRule => {
            let newPath = utils.cloneArr(path)
            newPath.push(currRefRule)
            return validateNoLeftRecursion(topRule, currRefRule, newPath)
        })

        return errors.concat(utils.flatten(errorsFromNextSteps))
    }
}

export function getFirstNoneTerminal(definition: IProduction[]): Rule[] {
    let result = []
    if (utils.isEmpty(definition)) {
        return result
    }
    let firstProd = utils.first(definition)

    if (firstProd instanceof NonTerminal) {
        result.push(firstProd.referencedRule)
    } else if (
        firstProd instanceof Flat ||
        firstProd instanceof Option ||
        firstProd instanceof RepetitionMandatory ||
        firstProd instanceof RepetitionMandatoryWithSeparator ||
        firstProd instanceof RepetitionWithSeparator ||
        firstProd instanceof Repetition
    ) {
        result = result.concat(
            getFirstNoneTerminal(<IProduction[]>firstProd.definition)
        )
    } else if (firstProd instanceof Alternation) {
        // each sub definition in alternation is a FLAT
        result = utils.flatten(
            utils.map(firstProd.definition, currSubDef =>
                getFirstNoneTerminal((<Flat>currSubDef).definition)
            )
        )
    } else if (firstProd instanceof Terminal) {
        // nothing to see, move along
    } else {
        /* istanbul ignore next */
        throw Error("non exhaustive match")
    }

    let isFirstOptional = isOptionalProd(firstProd)
    let hasMore = definition.length > 1
    if (isFirstOptional && hasMore) {
        let rest = utils.drop(definition)
        return result.concat(getFirstNoneTerminal(rest))
    } else {
        return result
    }
}

class OrCollector extends GAstVisitor {
    public alternations = []

    public visitAlternation(node: Alternation): void {
        this.alternations.push(node)
    }
}

export function validateEmptyOrAlternative(
    topLevelRule: Rule
): IParserEmptyAlternativeDefinitionError[] {
    let orCollector = new OrCollector()
    topLevelRule.accept(orCollector)
    let ors = orCollector.alternations

    let errors = utils.reduce(
        ors,
        (errors, currOr) => {
            let exceptLast = utils.dropRight(currOr.definition)
            let currErrors = utils.map(
                exceptLast,
                (currAlternative: IProduction, currAltIdx) => {
                    const possibleFirstInAlt = nextPossibleTokensAfter(
                        [currAlternative],
                        [],
                        null,
                        1
                    )
                    if (utils.isEmpty(possibleFirstInAlt)) {
                        return {
                            message:
                                `Ambiguous empty alternative: <${currAltIdx +
                                    1}>` +
                                ` in <OR${currOr.idx}> inside <${
                                    topLevelRule.name
                                }> Rule.\n` +
                                `Only the last alternative may be an empty alternative.`,
                            type: ParserDefinitionErrorType.NONE_LAST_EMPTY_ALT,
                            ruleName: topLevelRule.name,
                            occurrence: currOr.idx,
                            alternative: currAltIdx + 1
                        }
                    } else {
                        return null
                    }
                }
            )
            return errors.concat(utils.compact(currErrors))
        },
        []
    )

    return errors
}

export function validateAmbiguousAlternationAlternatives(
    topLevelRule: Rule,
    maxLookahead: number,
    ignoredIssues: IgnoredParserIssues
): IParserAmbiguousAlternativesDefinitionError[] {
    let orCollector = new OrCollector()
    topLevelRule.accept(orCollector)
    let ors = orCollector.alternations

    let ignoredIssuesForCurrentRule = ignoredIssues[topLevelRule.name]
    if (ignoredIssuesForCurrentRule) {
        ors = reject(
            ors,
            currOr =>
                ignoredIssuesForCurrentRule[
                    getProductionDslName(currOr) +
                        (currOr.idx === 0 ? "" : currOr.idx)
                ]
        )
    }

    let errors = utils.reduce(
        ors,
        (result, currOr: Alternation) => {
            let currOccurrence = currOr.idx
            let alternatives = getLookaheadPathsForOr(
                currOccurrence,
                topLevelRule,
                maxLookahead
            )
            let altsAmbiguityErrors = checkAlternativesAmbiguities(
                alternatives,
                currOr,
                topLevelRule.name
            )
            let altsPrefixAmbiguityErrors = checkPrefixAlternativesAmbiguities(
                alternatives,
                currOr,
                topLevelRule.name
            )

            return result.concat(altsAmbiguityErrors, altsPrefixAmbiguityErrors)
        },
        []
    )

    return errors
}

export class RepetionCollector extends GAstVisitor {
    public allProductions: IProduction[] = []

    public visitRepetitionWithSeparator(
        manySep: RepetitionWithSeparator
    ): void {
        this.allProductions.push(manySep)
    }

    public visitRepetitionMandatory(atLeastOne: RepetitionMandatory): void {
        this.allProductions.push(atLeastOne)
    }

    public visitRepetitionMandatoryWithSeparator(
        atLeastOneSep: RepetitionMandatoryWithSeparator
    ): void {
        this.allProductions.push(atLeastOneSep)
    }

    public visitRepetition(many: Repetition): void {
        this.allProductions.push(many)
    }
}

export function validateTooManyAlts(
    topLevelRule: Rule
): IParserDefinitionError[] {
    let orCollector = new OrCollector()
    topLevelRule.accept(orCollector)
    let ors = orCollector.alternations

    let errors = utils.reduce(
        ors,
        (errors, currOr) => {
            if (currOr.definition.length > 255) {
                errors.push({
                    message:
                        `An Alternation cannot have more than 256 alternatives:\n` +
                        `<OR${currOr.idx}> inside <${
                            topLevelRule.name
                        }> Rule.\n has ${currOr.definition.length +
                            1} alternatives.`,
                    type: ParserDefinitionErrorType.TOO_MANY_ALTS,
                    ruleName: topLevelRule.name,
                    occurrence: currOr.idx
                })
            }
            return errors
        },
        []
    )

    return errors
}

export function validateSomeNonEmptyLookaheadPath(
    topLevelRules: Rule[],
    maxLookahead: number
): IParserDefinitionError[] {
    let errors = []
    forEach(topLevelRules, currTopRule => {
        let collectorVisitor = new RepetionCollector()
        currTopRule.accept(collectorVisitor)
        let allRuleProductions = collectorVisitor.allProductions
        forEach(allRuleProductions, currProd => {
            let prodType = getProdType(currProd)
            let currOccurrence = currProd.idx
            let paths = getLookaheadPathsForOptionalProd(
                currOccurrence,
                currTopRule,
                prodType,
                maxLookahead
            )
            let pathsInsideProduction = paths[0]
            if (isEmpty(flatten(pathsInsideProduction))) {
                let dslName = getProductionDslName(currProd)
                if (currOccurrence !== 0) {
                    dslName += currOccurrence
                }
                let errMsg =
                    `The repetition <${dslName}> within Rule <${
                        currTopRule.name
                    }> can never consume any tokens.\n` +
                    `This could lead to an infinite loop.`
                errors.push({
                    message: errMsg,
                    type: ParserDefinitionErrorType.NO_NON_EMPTY_LOOKAHEAD,
                    ruleName: currTopRule.name
                })
            }
        })
    })

    return errors
}

export interface IAmbiguityDescriptor {
    alts: number[]
    path: TokenType[]
}

function checkAlternativesAmbiguities(
    alternatives: Alternative[],
    alternation: Alternation,
    topRuleName: string
): IParserAmbiguousAlternativesDefinitionError[] {
    let foundAmbiguousPaths = []
    let identicalAmbiguities = reduce(
        alternatives,
        (result, currAlt, currAltIdx) => {
            forEach(currAlt, currPath => {
                let altsCurrPathAppearsIn = [currAltIdx]
                forEach(alternatives, (currOtherAlt, currOtherAltIdx) => {
                    if (
                        currAltIdx !== currOtherAltIdx &&
                        containsPath(currOtherAlt, currPath)
                    ) {
                        altsCurrPathAppearsIn.push(currOtherAltIdx)
                    }
                })

                if (
                    altsCurrPathAppearsIn.length > 1 &&
                    !containsPath(foundAmbiguousPaths, currPath)
                ) {
                    foundAmbiguousPaths.push(currPath)
                    result.push({
                        alts: altsCurrPathAppearsIn,
                        path: currPath
                    })
                }
            })
            return result
        },
        []
    )

    let currErrors = utils.map(identicalAmbiguities, currAmbDescriptor => {
        let ambgIndices = map(
            currAmbDescriptor.alts,
            currAltIdx => currAltIdx + 1
        )
        let pathMsg = map(currAmbDescriptor.path, currtok =>
            tokenLabel(currtok)
        ).join(", ")
        let occurrence = alternation.idx === 0 ? "" : alternation.idx
        let currMessage =
            `Ambiguous alternatives: <${ambgIndices.join(
                " ,"
            )}> in <OR${occurrence}>` +
            ` inside <${topRuleName}> Rule,\n` +
            `<${pathMsg}> may appears as a prefix path in all these alternatives.\n`

        let docs_version = VERSION.replace(/\./g, "_")
        // Should this information be on the error message or in some common errors docs?
        currMessage =
            currMessage +
            "To Resolve this, try one of of the following: \n" +
            "1. Refactor your grammar to be LL(K) for the current value of k (by default k=5)\n" +
            "2. Increase the value of K for your grammar by providing a larger 'maxLookahead' value in the parser's config\n" +
            "3. This issue can be ignored (if you know what you are doing...), see" +
            " http://sap.github.io/chevrotain/documentation/" +
            docs_version +
            "/interfaces/iparserconfig.html#ignoredissues for more" +
            " details\n"

        return {
            message: currMessage,
            type: ParserDefinitionErrorType.AMBIGUOUS_ALTS,
            ruleName: topRuleName,
            occurrence: alternation.idx,
            alternatives: [currAmbDescriptor.alts]
        }
    })

    return currErrors
}

function checkPrefixAlternativesAmbiguities(
    alternatives: Alternative[],
    alternation: Alternation,
    ruleName
): IAmbiguityDescriptor[] {
    let errors = []

    // flatten
    let pathsAndIndices = reduce(
        alternatives,
        (result, currAlt, idx) => {
            let currPathsAndIdx = map(currAlt, currPath => {
                return { idx: idx, path: currPath }
            })
            return result.concat(currPathsAndIdx)
        },
        []
    )

    forEach(pathsAndIndices, currPathAndIdx => {
        let targetIdx = currPathAndIdx.idx
        let targetPath = currPathAndIdx.path

        let prefixAmbiguitiesPathsAndIndices = findAll(
            pathsAndIndices,
            searchPathAndIdx => {
                // prefix ambiguity can only be created from lower idx (higher priority) path
                return (
                    searchPathAndIdx.idx < targetIdx &&
                    // checking for strict prefix because identical lookaheads
                    // will be be detected using a different validation.
                    isStrictPrefixOfPath(searchPathAndIdx.path, targetPath)
                )
            }
        )

        let currPathPrefixErrors = map(
            prefixAmbiguitiesPathsAndIndices,
            currAmbPathAndIdx => {
                let ambgIndices = [currAmbPathAndIdx.idx + 1, targetIdx + 1]
                let pathMsg = map(currAmbPathAndIdx.path, currTok =>
                    tokenLabel(currTok)
                ).join(", ")
                let occurrence = alternation.idx === 0 ? "" : alternation.idx
                let currMessage =
                    `Ambiguous alternatives: <${ambgIndices.join(
                        " ,"
                    )}> due to common lookahead prefix\n` +
                    `in <OR${occurrence}> inside <${ruleName}> Rule,\n` +
                    `<${pathMsg}> may appears as a prefix path in all these alternatives.\n` +
                    `http://sap.github.io/chevrotain/website/Building_Grammars/resolving_grammar_errors.html#COMMON_PREFIX ` +
                    `For farther details.`

                return {
                    message: currMessage,
                    type: ParserDefinitionErrorType.AMBIGUOUS_PREFIX_ALTS,
                    ruleName: ruleName,
                    occurrence: occurrence,
                    alternatives: ambgIndices
                }
            }
        )
        errors = errors.concat(currPathPrefixErrors)
    })

    return errors
}

function checkTerminalAndNoneTerminalsNameSpace(
    ruleNames: string[],
    terminalNames: string[]
): IParserDefinitionError[] {
    let errors = []

    forEach(ruleNames, currRuleName => {
        if (contains(terminalNames, currRuleName)) {
            let errMsg =
                `Namespace conflict found in grammar.\n` +
                `The grammar has both a Terminal(Token) and a Non-Terminal(Rule) named: <${currRuleName}>.\n` +
                `To resolve this make sure each Terminal and Non-Terminal names are unique\n` +
                `This is easy to accomplish by using the convention that Terminal names start with an uppercase letter\n` +
                `and Non-Terminal names start with a lower case letter.`

            errors.push({
                message: errMsg,
                type: ParserDefinitionErrorType.CONFLICT_TOKENS_RULES_NAMESPACE,
                ruleName: currRuleName
            })
        }
    })

    return errors
}

function validateDuplicateNestedRules(
    topLevelRules: Rule[],
    errMsgProvider: IGrammarErrorMessageProvider
): IParserDefinitionError[] {
    let errors = []

    forEach(topLevelRules, currTopRule => {
        let namedCollectorVisitor = new NamedDSLMethodsCollectorVisitor("")
        currTopRule.accept(namedCollectorVisitor)
        let prodsByGroup = groupBy(
            namedCollectorVisitor.result,
            item => item.name
        )
        let duplicates: any = pick(prodsByGroup, currGroup => {
            return currGroup.length > 1
        })

        forEach(values(duplicates), (currDupGroup: any) => {
            const currDupProds = map(currDupGroup, dupGroup => dupGroup.orgProd)
            const errMsg = errMsgProvider.buildDuplicateNestedRuleNameError(
                currTopRule,
                currDupProds
            )

            errors.push({
                message: errMsg,
                type: ParserDefinitionErrorType.DUPLICATE_NESTED_NAME,
                ruleName: currTopRule.name
            })
        })
    })

    return errors
}
