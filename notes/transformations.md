# Overview of Transformations

This is an overview of the transformations for `elm-optimize-level-2`.

Not all of them made the cut, but seeing that a transformation is not as effective as initially thought is really good information.

We got a huge head start because of [Robin's article](https://dev.to/skinney/improving-elm-s-compiler-output-5e1h).

Each transformation also has a rough summary of impact.

# Applying Functions Directly

Elm wraps functions in an object that tracks how many arguments the function takes(also known as 'arity').

This is so that functions can be partially applied, meaning you can apply a few arguments and get a new function that has those arguments "built in".

The most significant speedups we've seen is in finding places where we can skip the wrapper and call the actual function directly. This happens when you call a function with exactly the number of arguments it needs.

In order to do this, we need to adjust function declarations so that the original function can be called either in the standard 'wrapped' way, or directly.

before

```js
var MyFunction = F2(function (tag, value) {
  return value;
});
```

after

```js
var MyFunction_fn = function (tag, value) {
    return value;
  },
  MyFunction = F2(MyFunction_fn);
```

Then, if this function is called with `A2`, we can unwrap the wrapper and call the function directly.

before

```js
A2(MyFunction, one two)
```

after

```js
MyFunction_fn(one two)
```

## Results Summary

- Included in `elm-optimize-level-2` tool\*\*
- Potentially large positive effect on speed
- Likley small but positive effect on asset size

This has lead to dramatic speedups in some cases, especially when a large number of smaller functions are called and the overhead of calling twice as many functions is significant.

As well, it has a really interesting characteristic in that it makes the initial size of the generated JS **larger**, but usually results in a **smaller** minified asset size.

We generate two definitions for a function, but in most cases a function is either always partially applied, or always called with the full number of arguments.

If a function is always called with the full number of arguments, the minifier can eliminate our wrapped version (`F2(MyFunction_fn)`) and _also_ eliminate the `A2` call, which is explicitly smaller than before.

# Passing unwrapped functions and calling them directly

Let's say we have some elm code that produces the following js.

```js
var f = function (func, a, b) {
  return A2(func, a, b);
};

f(
  F2(function (a, b) {
    return a + b;
  }),
  1,
  2
);
```

we can transform it to

```js
var f = function (func, a, b) {
    return A2(func, a, b);
  },
  f_unwrapped = function (func, a, b) {
    return func(a, b); // <-- direct function call!
  };

// note that the lambda is unwrapped as well
f_unwrapped(
  function (a, b) {
    return a + b;
  },
  1,
  2
);
```

This transformation works with separately defined functions too.

# Passing in Unwrappable Functions to Higher Order Functions

**Future Work**

Higher order functions like `List.map` have a hard time taking advantage of the direct function calls because we don't know the arity of the function within the `List.map` call.

This is a challenging case, but worth exploring!

# Making type representation isomorphic

Currently the Elm compiler will generate objects that match the shape of a given type.

`Maybe` looks like this:

```js
var elm$core$Maybe$Just = function (a) {
  return { $: 0, a: a };
};

var elm$core$Maybe$Nothing = { $: 1 };
```

However, the V8 engine is likely better able to optimize these objects if they have the same shape.

So, this transformation fills out the rest of the variants with `field: null` so that they have the same shape.

```js
var elm$core$Maybe$Just = function (a) {
  return { $: 0, a: a };
};

var elm$core$Maybe$Nothing = { $: 1, a: null };
```

This does require information from the Elm code itself, which we're currently getting through `elm-tree-sitter`.

## Results Summary

- Partially Included - We stub in shapes for `Maybe` and `List`, but that's it.
- Has an effect in certain circumstances in browsers using V8(Chrome and Edge). Nothing observable otherwise.
  - Most prominently observed in the `Elm Core - sum 300 list of custom types` benchmark. Otherwise I didn't notice it.
- No noticable effect on asset size.
- More work is needed to make parsing an existing project more robust and also to discover what approach for representing the shapes actually produces the best benefit.

# Inlining literal list constructors

Before

```js
_List_fromArray(['a', 'b', 'c']);
```

After, using `InlineMode.UsingConsFunc`

```js
_List_cons('a', _List_cons('b', _List_cons('c', _List_Nil)));
```

with `InlineMode.UsingLiteralObjects`

```js
({ $: 1, a: 'a', b: { $: 1, a: 'b', b: { $: 1, a: 'c', b: _List_Nil } } });
```

_Note_ - Elm actually had this originally (the literal objects version)! But there's an issue in Chrome with more than 1000 elements.

There's also tradeoff between asset size and speed.

Also of note, because `_List_fromArray` is used for lists of _anything_, that it's likely being deoptimized by the JavaScript compiler.

There may be a nice trade-off here of using `InlineMode.UsingConsFunc`, but only inlining at most 20 elements or something, and then using `List_fromArray` after that.

## Results Summary

- Not included in the elm-optimize-level-2 tool because it was hard to find a benchmark that reported numbers to justify it.
- Though maybe we just need to be better at benchmarking it.

# Object Update

When updating a record in Elm via `{ record | field = new }`, Elm runs the following function:

```javascript
function _Utils_update(oldRecord, updatedFields) {
  var newRecord = {};
  for (var key in oldRecord) {
    newRecord[key] = oldRecord[key];
  }
  for (var key in updatedFields) {
    newRecord[key] = updatedFields[key];
  }
  return newRecord;
}
```

We tried a few different variations in order to see if we could speed this up.

The trick here is that we need to copy the entire record so that it has a new reference.

So, we can't just do `record.field = new` in the js.

All of these tricks rely on either the spread operator or `Object.assign`, both of which are not supported in IE.

## Replacing the implementation of `_Util_update`:

Spread operator

```javascript
const _Utils_update = (oldRecord, updatedFields) => {
  var newRecord = { ...oldRecord };

  for (var key in updatedFields) {
    newRecord[key] = updatedFields[key];
  }
  return newRecord;
};
```

Spread for both

```javascript
const _Utils_update = (oldRecord, updatedFields) => ({
  ...oldRecord,
  ...updatedFields,
});
```

Use Object.assign

```javascript
const _Utils_update = (oldRecord, updatedFields) =>
  Object.assign({}, oldRecord, updatedFields);
```

## Inline the call altogether

At the call site, replace

```js
_Utils_update(old, newFields);
```

with

```js
Object.assign({}, old, newFields);
```

Or we can use the spread operator inline:

```js
{...old, field: new}
```

## Result Summary

- Not included in elm-optimize-level-2 tool
- Again, all of these tricks rely on either the spread operator or `Object.assign`, both of which are not supported in IE.
- The most promising approach was inlining the call completely with `{...old, field: newValue}`.
  - Gave a `501%` boost in chrome!
  - And caused safari to reduce performance by 50% :sweat_smile:

Simply creating a new record and copying each field manually is significantly faster than any of these transformations (~9x in chrome, and ~6.5x in firefox). You can do this directly in Elm.

```
updateSingleRecordManually record =
    { one = 87
    , two = record.two
    , three = record.three
    }
```

It's worth exploring automating this transformation, though of course there's a question of how much this affects asset size on larger projects.

However, it's hard to explore further without knowing the actual shape of the records being updated.

**Future work**
Explore more approaches. Next on TODO list:

```
_Utils_update(old, {a: newA})
```

to

```
{...old, a: newA}
```

# Inline Equality

If Elm's `==` is applied to any primitive such as:

- Int
- Float
- String
- Bool

Then we can inline the definition directly as JS strict equality: `===`.

Right now `elm-optimize-level-2` will infer if something is a primitive if a literal is used.

## Results Summary

- Included in `elm-optimize-level-2` tool.
- Looks to have the some impact on code that does a lot of equality comparisons, like parsing.

The `_Utils_eq` function is very likely deoptimized because it can take _any_ two values and either do a reference check, or do structural equality, which we also know takes a while.

So, my guess is the benefit here is from avoiding the call to a deoptimized function completely.

Chrome doesn't really see a speedup here though, so it's likely smart enough to do that already.

# Inline String.fromFloat/Int

Before

```js
String$fromFloat(val);
```

After:

```js
val + '';
```

## Results Summary

- Not included in the tool

This hasn't shown any measureable benefit. Likely because this is such a simple function that all js compilers are already optimizing the intermedaite calls.

# Arrowizing Functions

Before

```js
var x = function (x) {};
```

After

```js
var x = (x) => {};
```

This was done for asset size. The nuance being that it's done to potentially optimize the _minified_ size of code, but not necessarily the gzipped version.

This is still a benefit because the minified code is what ultimately needs to be parsed and parsing is one of the larger steps on the way to getting a page running.

## Results Summary

- Not included in the `elm-optimize-level-2` tool
- Comes with the caveat that the [code will not work on IE](https://caniuse.com/#feat=arrow-functions)

We weren't able to pin down a benchmark where this reported a benefit in the numbers, though likely to explore this we need (1) A larger codebase, and (2)

We didn't include this in the first version of the tool because the effect seems to be so modest and carries the risk of breaking things on IE.

We would have to add something like a `--modernize` or `--no-ie` flag to the tool, and I really like this tool having no configurability.

# Lifting Constants

**Future Work**

This transformation hasn't been attempted yet, but the idea is that if a constant is detected in a let statement, it can be declared moved to top-level instead of recalculated every function run.

This is risky! You do less computation, but you are (1) moving a bunch of computation to happen on start-up and (2) the results are allocated but can never be freed.
This could be worthwhile in HTML though, where there is a x === y check on nodes:
https://github.com/elm/virtual-dom/blob/master/src/Elm/Kernel/VirtualDom.js#L706-L709
So, if two nodes were reference equal, you wouldn't have to ever diff them. I imagine this could be a big benefit if there was a long list where each element contained a somewhat large "constant" node for some UI thing.

# Eta Conversion

This is when you add or remove anonymous functions:
`map (f x y) zs` to `map (\z -> f x y z) zs`

Because of our previous optimizations where we can call a function directly, this can make sure we're getting the fast version of `f`!

# Tail Recursion Modulo Cons

Whew, what a name!

In Elm, if you have a recursive function that calls itself at the top level, then it will be compiled into a while loop. Here's an example:

```elm
sum : Int -> List Int ->  Int
sum current list =
  case list of
    [] ->
        current

    (x :: remaining) ->
        sum (x + current) remaining
```

The critical part here is that `sum` is called as the _first thing_ on that branch. Because that's easy to detect, we can reliably convert the above code into a `while` loop. (Note, all this stuff is called _Tail Call Optimization_).

However, it's a pretty common case where we can't quite do that.

Let's take a look at an implementation of `List.map`. (Note, this isn't how Elm currently does it, this is just for illustrative purposes.)

We could implement `List.map` like this:

```elm
type List a = Nil | Cons a (List a)

map : (a -> b) -> List a -> List b
map func list =
  case list of
    Nil -> Nil
    Cons x xs ->
      Cons (func x) (map func xs)
```

But our recursive function(`map`) is not the _first thing_ being called in that branch! It's the `Cons` constructor! (Heyy, Tail Recursion Modulo **Cons**)

The idea for this transformation is that we could take the above code, and generate the following JS code.

```js
function map(func, list) {
  var first;
  var prev;
  while (true) {
    if (list.$ === 'Nil') {
      if (prev) {
        prev.b = Nil;
      } else {
        first = Nil;
      }
      return first;
    } else {
      var node = Cons(func(list.a), null);
      if (prev) {
        prev.b = node;
      } else {
        first = node;
      }
      prev = node;
      list = list.b;
    }
  }
}
```

# Skip Allocating Tuples in Case Expression

It's pretty common to put things in a tuple (or threeple) to start a case expression.

```elm
    case (a, b) of
       (ThingOne, ThingTwo) ->
          --...
```

We could skip allocating the tuple though.

**Note:** the elm compiler seems to already optimize this.

# String Joining

For joining (and concating) strings, Elm uses Javascript's Array join method after converting the list into a Javascript array.
We can replace this implementation with a faster one that traverses the list and builds the string through concatenation instead.

## Results Summary

* Not included in elm-optimize-level-2 tool
* The implementation used is similar to the improved String.join implementation [here](https://gitlab.com/e-neighborhood-watch/elm-string-benchmarks/#stringjoin) which sees some serious improvements over Elm's normal String.join.
