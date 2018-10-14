import { ErrorHandler } from "./error_handler"
import { LexerAdapter } from "./lexer_adapter"
import { LooksAhead } from "./looksahead"
import { RecognizerApi } from "./recognizer_api"
import { RecognizerEngine } from "./recognizer_engine"
import { Recoverable } from "./recoverable"
import { TreeBuilder } from "./tree_builder"
import { Parser as ParserConstructorImpel } from "../parser_public"
import * as defs from "../../../api"

/**
 * This Type combines all the Parser traits.
 * It is used in all traits in the "this type assertion"
 * - https://github.com/Microsoft/TypeScript/wiki/What%27s-new-in-TypeScript#specifying-the-type-of-this-for-functions
 * This enables strong Type Checks inside trait methods that invoke methods from other traits.
 * This pattern is very similar to "self types" in Scala.
 * - https://docs.scala-lang.org/tour/self-types.html
 */
export type MixedInParser = ParserConstructorImpel &
    ErrorHandler &
    LexerAdapter &
    LooksAhead &
    RecognizerApi &
    RecognizerEngine &
    Recoverable &
    TreeBuilder

interface MixedInParserConstructor {
    new (
        tokenVocabulary: defs.TokenVocabulary,
        config?: defs.IParserConfig
    ): defs.Parser
}

export const Parser: MixedInParserConstructor = <any>ParserConstructorImpel