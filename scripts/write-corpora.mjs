/**
 * Minimal corpus per language — the evidence a descriptor is accepted on.
 *
 * The prober can propose a node-type → kind mapping from names alone, and that
 * proposal is WRONG in ways only a parse can reveal (it pointed at
 * `variable_declaration` when the symbol is `variable_declarator`; it could not
 * know that `method_definition` inside an object literal is a property). So a
 * descriptor is only trusted once a real file has exercised it.
 *
 * Each corpus below deliberately contains every declaration form the language
 * has among our ten kinds, so the "in corpus:" column in the prober's output is
 * meaningful. A form that is absent from the corpus is a form nobody verified.
 *
 * Dev tool. Writes the corpora to .tmp/corpora/ and prints nothing else.
 *   node scripts/write-corpora.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** language id → [extension, source]. */
const CORPORA = {
	go: [".go", `package main

import (
	"fmt"
	"os"
)

const Version = "1.0"

var counter int

type Shape interface {
	Area() float64
}

type Point struct {
	X int
	Y int
}

type Color int

const (
	Red Color = iota
	Green
)

func (p Point) Area() float64 {
	return float64(p.X * p.Y)
}

func Add(a int, b int) int {
	return a + b
}

func main() {
	fmt.Println(Add(1, 2), os.Args, counter)
}
`],

	rust: [".rs", `use std::fmt;
use std::collections::HashMap;

pub const MAX: usize = 10;

pub static NAME: &str = "x";

pub type Alias = HashMap<String, usize>;

pub trait Draw {
	fn draw(&self);
}

pub struct Point {
	pub x: i32,
	pub y: i32,
}

pub enum Color {
	Red,
	Green,
}

impl Point {
	pub fn area(&self) -> i32 {
		self.x * self.y
	}
}

impl fmt::Display for Point {
	fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
		write!(f, "{}", self.x)
	}
}

pub fn add(a: i32, b: i32) -> i32 {
	a + b
}
`],

	java: [".java", `package com.example;

import java.util.List;
import java.util.Map;

public interface Shape {
	double area();
}

public enum Color {
	RED, GREEN
}

public class Point implements Shape {
	private int x;
	private int y;

	public Point(int x, int y) {
		this.x = x;
		this.y = y;
	}

	@Override
	public double area() {
		return x * y;
	}

	public static int add(int a, int b) {
		return a + b;
	}
}
`],

	c: [".c", `#include <stdio.h>
#include "local.h"

#define MAX 10

typedef struct Point {
	int x;
	int y;
} Point;

enum Color { RED, GREEN };

static int counter = 0;

int add(int a, int b) {
	return a + b;
}

static double area(Point p) {
	return p.x * p.y;
}

int main(void) {
	printf("%d", add(1, 2));
	return 0;
}
`],

	cpp: [".cpp", `#include <vector>
#include <string>

namespace geo {

using Scalar = double;

enum class Color { Red, Green };

class Shape {
public:
	virtual double area() const = 0;
};

struct Point {
	int x;
	int y;
};

class Circle : public Shape {
public:
	double radius;
	double area() const override {
		return radius;
	}
};

double add(double a, double b) {
	return a + b;
}

} // namespace geo
`],

	"c-sharp": [".cs", `using System;
using System.Collections.Generic;

namespace Example
{
    public interface IShape
    {
        double Area();
    }

    public enum Color { Red, Green }

    public struct Point
    {
        public int X;
        public int Y;
    }

    public class Circle : IShape
    {
        private double radius;

        public double Radius
        {
            get { return radius; }
        }

        public double Area()
        {
            return radius;
        }

        public static int Add(int a, int b)
        {
            return a + b;
        }
    }
}
`],

	ruby: [".rb", `require "json"
require_relative "helper"

MAX = 10

module Geo
  class Point
    attr_reader :x

    def initialize(x, y)
      @x = x
      @y = y
    end

    def area
      @x * @y
    end

    def self.origin
      new(0, 0)
    end
  end
end

def add(a, b)
  a + b
end
`],

	php: [".php", `<?php

namespace Example;

use Foo\\Bar;
use const Foo\\BAZ;

interface Shape
{
    public function area(): float;
}

trait HasName
{
    public function name(): string
    {
        return "x";
    }
}

class Point implements Shape
{
    private int $x = 0;

    public function area(): float
    {
        return (float) $this->x;
    }

    public static function add(int $a, int $b): int
    {
        return $a + $b;
    }
}

function helper(int $a): int
{
    return $a;
}
`],

	bash: [".sh", `#!/usr/bin/env bash

source ./lib.sh

VERSION="1.0"
readonly MAX=10

add() {
	local a="$1"
	local b="$2"
	echo $((a + b))
}

function greet {
	echo "hi $1"
}

main() {
	add 1 2
	greet world
}

main "$@"
`],

	scala: [".scala", `package example

import scala.collection.mutable

trait Shape {
  def area: Double
}

sealed trait Color
case object Red extends Color

case class Point(x: Int, y: Int) {
  def area: Double = x * y
}

object Geo {
  val Max: Int = 10
  type Alias = mutable.Map[String, Int]

  def add(a: Int, b: Int): Int = a + b
}
`],

	elixir: [".ex", `defmodule Geo do
  @moduledoc "Geometry helpers"

  import Enum, only: [map: 2]

  alias Geo.Point

  @max 10

  defmodule Point do
    defstruct x: 0, y: 0

    def area(%Point{x: x, y: y}) do
      x * y
    end
  end

  def add(a, b) do
    a + b
  end

  defp helper(x), do: x
end
`],

	haskell: [".hs", `module Geo where

import Data.List (sort)
import qualified Data.Map as Map

data Color = Red | Green

newtype Wrapper = Wrapper Int

type Alias = Map.Map String Int

class Shape a where
  area :: a -> Double

instance Shape Circle where
  area c = radius c

data Circle = Circle { radius :: Double }

maxSize :: Int
maxSize = 10

add :: Int -> Int -> Int
add a b = a + b

area2 :: Circle -> Double
area2 = area
`],

	ocaml: [".ml", `open List

module Geo = struct
  type point = { x : int; y : int }

  type color = Red | Green

  let origin = { x = 0; y = 0 }

  let area p = p.x * p.y
end

exception Bad of string

class counter = object
  val mutable n = 0
  method incr = n <- n + 1
end

let max_size = 10

let add a b = a + b
`],

	julia: [".jl", `module Geo

import Base: show
using LinearAlgebra

const MAX = 10

abstract type Shape end

struct Point <: Shape
    x::Int
    y::Int
end

mutable struct Counter
    n::Int
end

function area(p::Point)
    p.x * p.y
end

area(p::Point, scale::Int) = area(p) * scale

macro twice(ex)
    return :($(esc(ex)) * 2)
end

end # module
`],

	svelte: [".svelte", `<script>
	import { onMount } from "svelte";
	import Child from "./Child.svelte";

	export let name = "world";
	let count = 0;
	const MAX = 10;

	function increment() {
		count += 1;
	}

	onMount(() => {
		increment();
	});
</script>

<h1>Hello {name}</h1>
<button on:click={increment}>{count} / {MAX}</button>
<Child />
`],

	dart: [".dart", `import 'dart:math';
import 'package:meta/meta.dart';

const maxSize = 10;

abstract class Shape {
  double area();
}

enum Color { red, green }

mixin Named {
  String get name => 'x';
}

class Point extends Shape with Named {
  final int x;
  final int y;

  Point(this.x, this.y);

  @override
  double area() => (x * y).toDouble();

  static int add(int a, int b) {
    return a + b;
  }
}

int helper(int a) => a;
`],

	css: [".css", `@import url("base.css");

:root {
	--accent: #4c8dff;
	--gap: 8px;
}

.card {
	display: flex;
	gap: var(--gap);
	border-radius: 12px;
}

.card .title {
	font-weight: 600;
}

#main {
	padding: var(--gap);
}

@media (min-width: 600px) {
	.card {
		flex-direction: row;
	}
}
`],

	html: [".html", `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<title>Sample</title>
	<link rel="stylesheet" href="a.css" />
</head>
<body>
	<header id="top">
		<h1 class="title">Hello</h1>
	</header>
	<main>
		<p>Body text</p>
		<ul>
			<li>one</li>
			<li>two</li>
		</ul>
	</main>
	<script src="a.js"></script>
</body>
</html>
`],

	json: [".json", `{
	"name": "sample",
	"version": "1.0.0",
	"private": true,
	"nested": {
		"count": 3,
		"items": [1, 2, 3],
		"flags": { "a": true, "b": false }
	}
}
`],
};

const dir = ".tmp/corpora";
mkdirSync(dir, { recursive: true });
for (const [id, [extension, source]] of Object.entries(CORPORA)) {
	writeFileSync(join(dir, `${id}${extension}`), source);
}
console.log(`wrote ${Object.keys(CORPORA).length} corpora to ${dir}/`);
